# R4-A-04 Hardware Debug Resolve

This fixture loads `alpha-mask.gltf` through the public packed glTF loader,
cooks and uploads it to the production Renderer, then displays the packed
`VisibilityKey` debug resolve. A second GPU run uses the same authored WGSL to
verify stable fail-visible colors for empty, invalid/max keys and every lookup
failure layer.
