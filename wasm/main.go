//go:build js && wasm

// WebAssembly entry point: runs the original paulmach/slide algorithm in the browser.
// JS passes the selected path (lon/lat), a heatmap intensity grid (+ its lon/lat bounds),
// and the smoothing std-dev; we return the corrected path (lon/lat).
package main

import (
	"image"
	"image/color"
	"syscall/js"

	geo "github.com/paulmach/go.geo"
	"github.com/paulmach/slide"
	slideimage "github.com/paulmach/slide/surfacers/image"
)

func doSlide(this js.Value, args []js.Value) (result interface{}) {
	defer func() {
		if r := recover(); r != nil {
			result = map[string]interface{}{"ok": false, "error": "panic in slide"}
		}
	}()

	req := args[0]
	w := req.Get("width").Int()
	h := req.Get("height").Int()

	// grid: Uint8Array, length w*h, row-major, row 0 = north, col 0 = west, value 0..255
	pix := make([]byte, w*h)
	js.CopyBytesToGo(pix, req.Get("grid"))
	img := image.NewGray(image.Rect(0, 0, w, h))
	copy(img.Pix, pix)

	bound := geo.NewBound(
		req.Get("west").Float(),
		req.Get("east").Float(),
		req.Get("south").Float(),
		req.Get("north").Float(),
	)

	pathJS := req.Get("path")
	n := pathJS.Length()
	path := geo.NewPath()
	for i := 0; i < n; i++ {
		p := pathJS.Index(i)
		path.Push(geo.NewPoint(p.Index(0).Float(), p.Index(1).Float()))
	}

	surfacer := slideimage.New(bound, img, color.White, req.Get("smoothingStdDev").Float())
	if err := surfacer.Build(); err != nil {
		return map[string]interface{}{"ok": false, "error": err.Error()}
	}

	s := slide.New([]*geo.Path{path}, surfacer)
	// Heatmap-tuned weights (from the Go stravaheat surfacer), each overridable from JS.
	s.GradientScale = 0.5
	s.DistanceScale = 0.2
	s.AngleScale = 0.1
	s.MomentumScale = 0.7
	if v := req.Get("gradientScale"); !v.IsUndefined() {
		s.GradientScale = v.Float()
	}
	if v := req.Get("distanceScale"); !v.IsUndefined() {
		s.DistanceScale = v.Float()
	}
	if v := req.Get("angleScale"); !v.IsUndefined() {
		s.AngleScale = v.Float()
	}
	if v := req.Get("momentumScale"); !v.IsUndefined() {
		s.MomentumScale = v.Float()
	}
	if v := req.Get("resampleInterval"); !v.IsUndefined() {
		s.ResampleInterval = v.Float()
	}
	res, err := s.Do()
	if err != nil {
		return map[string]interface{}{"ok": false, "error": err.Error()}
	}

	corrected := res.CorrectedGeometry[0]
	out := make([]interface{}, corrected.Length())
	for i := 0; i < corrected.Length(); i++ {
		pt := corrected.GetAt(i)
		out[i] = []interface{}{pt.Lng(), pt.Lat()}
	}
	return map[string]interface{}{"ok": true, "path": out, "loops": res.LoopsCompleted}
}

func main() {
	js.Global().Set("__slideV2Wasm", js.FuncOf(doSlide))
	js.Global().Set("__slideV2WasmReady", js.ValueOf(true))
	select {}
}
