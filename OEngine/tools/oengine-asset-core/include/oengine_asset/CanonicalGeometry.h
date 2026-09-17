#pragma once

#include "GeometryCooker.h"

namespace oengine::asset {

void GenerateCanonicalNormalsV3(MaterialDomain& domain);
void FinalizeCanonicalGeometryAssetV3(CanonicalGeometryAsset& asset);

}  // namespace oengine::asset
