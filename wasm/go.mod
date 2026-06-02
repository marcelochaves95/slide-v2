module slidewasm

go 1.26

require (
	github.com/paulmach/go.geo v0.0.0-20180829195134-22b514266d33
	github.com/paulmach/slide v0.0.0
)

require github.com/paulmach/go.geojson v1.5.0 // indirect

replace github.com/paulmach/slide => ../algorithm-reference
