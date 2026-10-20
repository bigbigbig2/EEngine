#pragma once

#include "GeometryCooker.h"

namespace oengine::asset {

void GenerateCanonicalNormalsV4(MaterialDomain& domain);
void FinalizeCanonicalGeometryAssetV4(CanonicalGeometryAsset& asset);

}  // namespace oengine::asset
