#include <algorithm>
#include <atomic>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace Math {
struct Vector3 { float x=0,y=0,z=0; Vector3()=default; Vector3(float a,float b,float c):x(a),y(b),z(c){} float GetX()const{return x;} float GetY()const{return y;} float GetZ()const{return z;} };
struct Quaternion { Quaternion()=default; explicit Quaternion(int){} };
struct Matrix3 { Matrix3()=default; explicit Matrix3(Quaternion){} static Matrix3 MakeScale(Vector3){return{};} Matrix3 operator*(Matrix3)const{return{};} };
struct Matrix4 { float m[16]{}; explicit Matrix4(int=0){m[0]=m[5]=m[10]=m[15]=1.f;} Matrix4(Matrix3,Vector3 t):Matrix4(0){m[12]=t.x;m[13]=t.y;m[14]=t.z;} Matrix4 operator*(const Matrix4& b)const{Matrix4 o(0);o.m[12]=m[12]+b.m[12];o.m[13]=m[13]+b.m[13];o.m[14]=m[14]+b.m[14];return o;} Vector3 operator*(Vector3 v)const{return{v.x+m[12],v.y+m[13],v.z+m[14]};} Vector3 GetX()const{return{m[0],m[1],m[2]};} Vector3 GetY()const{return{m[4],m[5],m[6]};} Vector3 GetZ()const{return{m[8],m[9],m[10]};} };
struct BoundingSphere { Vector3 center{}; float radius=0; BoundingSphere()=default; explicit BoundingSphere(Vector3 c):center(c){} BoundingSphere(Vector3 c,float r):center(c),radius(r){} Vector3 GetCenter()const{return center;} float GetRadius()const{return radius;} BoundingSphere Union(const BoundingSphere& b)const{return{center,std::max(radius,b.radius)};} BoundingSphere Union(const struct AxisAlignedBox&)const{return *this;} };
struct AxisAlignedBox { Vector3 min{},max{}; AxisAlignedBox()=default; explicit AxisAlignedBox(Vector3 p):min(p),max(p){} Vector3 GetMin()const{return min;} Vector3 GetMax()const{return max;} void AddBoundingBox(const AxisAlignedBox& b){min={std::min(min.x,b.min.x),std::min(min.y,b.min.y),std::min(min.z,b.min.z)};max={std::max(max.x,b.max.x),std::max(max.y,b.max.y),std::max(max.z,b.max.z)};} void AddPoint(Vector3 p){min={std::min(min.x,p.x),std::min(min.y,p.y),std::min(min.z,p.z)};max={std::max(max.x,p.x),std::max(max.y,p.y),std::max(max.z,p.z)};} };
inline float Length(Vector3 v){return std::sqrt(v.x*v.x+v.y*v.y+v.z*v.z);}
}
struct cgltf_primitive{}; struct cgltf_mesh{std::size_t primitives_count=1;cgltf_primitive* primitives=nullptr;};
struct cgltf_camera{int type=0;struct{struct{float yfov=0,aspect_ratio=0,znear=0,zfar=0;}perspective;}data;};
struct cgltf_node{std::size_t children_count=0;cgltf_node**children=nullptr;bool has_matrix=false;float matrix[16]{};bool has_translation=false;float translation[3]{};bool has_scale=false;float scale[3]{};bool has_rotation=false;float rotation[4]{};cgltf_mesh*mesh=nullptr;cgltf_camera*camera=nullptr;};
struct cgltf_scene{std::size_t nodes_count=0;cgltf_node**nodes=nullptr;}; struct cgltf_data{std::size_t nodes_count=0;cgltf_scene*scene=nullptr;cgltf_scene*scenes=nullptr;}; constexpr int cgltf_camera_type_perspective=1;
const Math::Vector3 kOrigin{},kOne{1,1,1},kZero{};constexpr int kIdentity=0;namespace DirectX{inline int XMVectorSet(float,float,float,float){return 0;}}
struct XMFLOAT3{float x=0,y=0,z=0;XMFLOAT3()=default;XMFLOAT3(float a,float b,float c):x(a),y(b),z(c){}};
namespace Renderer {
inline constexpr uint32_t kPageSizeInBytes=256u*1024u;
struct CameraData{enum{kPerspective};int type=0;float yfov=0,aspectRatio=0,znear=0,zfar=0;uint32_t matrixIdx=0;}; struct GraphNode{bool hasChildren=false,hasSibling=false;uint32_t matrixIdx=0;Math::Matrix4 xform{};Math::Quaternion rotation{};XMFLOAT3 scale;};
struct GroupMetadata{uint32_t SizeBytes=64,UncompressedSize=64,PageIndex=0,OffsetInPage=0;}; struct PageMetadata{uint32_t GroupStart=0,GroupCount=0;}; struct HierarchyNode{struct{uint32_t IsGroup=1,GroupIndex=0;}Leaf;struct{uint32_t IsGroup=0,ChildStartIndex=0;}Internal;float MaxParrentError=0;};
struct PendingGroupWrite{std::wstring TempSourcePath;uint64_t SourceOffset=0,SizeBytes=0;uint32_t BaseGroupIndexPatchValue=0;}; struct GlobalStreamingContext{uint64_t TotalGeometrySize=0;uint32_t CurrentPageIndex=0,CurrentOffsetInPage=0;std::vector<char>ZeroBuffer;std::vector<PendingGroupWrite>PendingWrites;std::vector<std::wstring>TempFilesToClean;GlobalStreamingContext():ZeroBuffer(kPageSizeInBytes,0){}~GlobalStreamingContext(){for(const auto&f:TempFilesToClean)std::remove(std::string(f.begin(),f.end()).c_str());}};
struct Mesh{uint32_t numDraws=0;};struct MaterialConstantData{};struct MaterialTextureData{}; struct ModelData{Math::BoundingSphere m_BoundingSphere;Math::AxisAlignedBox m_BoundingBox;std::vector<GroupMetadata>m_GroupInfos;std::vector<HierarchyNode>m_Nodes;std::vector<PageMetadata>m_Pages;std::vector<MaterialTextureData>m_MaterialTextures;std::vector<MaterialConstantData>m_MaterialConstants;std::vector<Mesh*>m_Meshes;std::vector<GraphNode>m_SceneGraph;std::vector<std::string>m_TextureNames;std::vector<uint8_t>m_TextureOptions;std::vector<CameraData>m_Cameras;uint64_t m_TriangleCount=0;};
}
namespace glTF{struct GltfAsset{cgltf_data*m_Data=nullptr;std::wstring m_BasePath;};}
using namespace Math;using namespace Renderer; struct CompiledPrimitive{uint32_t rootNodeIndex=0,indexCount=3;AxisAlignedBox bboxLS{};uint16_t materialIdx=0,psoFlags=3,vertexStride=16;}; struct CompiledMeshData{std::vector<CompiledPrimitive>primitives;BoundingSphere boundsLS{};AxisAlignedBox bboxLS{};}; struct MeshBuildResult{const cgltf_mesh*sourceMesh=nullptr;CompiledMeshData meshData;std::vector<struct MeshletBuildProducts>logicProducts;std::wstring tempFilePath;}; struct MeshInstanceRequest{const cgltf_mesh*mesh=nullptr;uint32_t nodeIndex=0;Matrix4 worldXform{};}; using MeshCache=std::unordered_map<const cgltf_mesh*,CompiledMeshData>;using NodeMap=std::unordered_map<const cgltf_node*,uint32_t>;
struct Primitive{uint32_t hash=0,materialIdx=0,psoFlags=3,vertexStride=16,primCount=3;std::vector<uint8_t>*VB=new std::vector<uint8_t>(64,0);std::vector<uint32_t>*IB=new std::vector<uint32_t>{0,1,2};AxisAlignedBox m_BoundsOS{},m_BBoxOS{},m_BBoxLS{};}; struct MeshletBuildArgs{uint16_t meshBufferIndex=0,materialBufferIndex=0,psoFlags=0,vertexStride=0;uint32_t vertexCount=0,indexCount=0,baseGroupIndex=0,baseNodeIndex=0;unsigned char*VBData=nullptr;unsigned char*IBData=nullptr;};
namespace Utility{inline void Printf(const char*,...){ }inline std::wstring UTF8ToWideString(const std::string&s){return{s.begin(),s.end()};}} inline int omp_get_max_threads(){return 1;} inline void OptimizeMesh(Primitive&,const cgltf_data*,const cgltf_primitive&,const Matrix4&){}
struct MeshletBuildProducts{struct Group{GroupMetadata Metadata{};std::vector<uint8_t>Blob{64,0};uint64_t TempFileOffset=0;};std::vector<Group>Groups;std::vector<HierarchyNode>Hierarchy;}; namespace MeshletBuilder{inline MeshletBuildProducts Build(const MeshletBuildArgs&){MeshletBuildProducts p;p.Groups.emplace_back();p.Hierarchy.emplace_back();return p;}}
inline void BuildMaterials(ModelData&,const glTF::GltfAsset&){} inline void BuildAnimations(ModelData&,const glTF::GltfAsset&,const NodeMap&){} inline void BuildSkins(ModelData&,const glTF::GltfAsset&,const NodeMap&){} inline void InstantiateMesh(ModelData&m,const CompiledMeshData&,uint32_t){m.m_Meshes.push_back(new Mesh{1});}
namespace Renderer{bool BuildModel(ModelData&,const glTF::GltfAsset&,GlobalStreamingContext&,int);}

MODEL_CONVERT_PARALLEL_COMPILE_MESHES
MODEL_CONVERT_WALK_GRAPH
MODEL_CONVERT_BUILD_MODEL

int main(){cgltf_mesh shared{},second{};cgltf_camera camera{};camera.type=cgltf_camera_type_perspective;camera.data.perspective={1.1f,1.7f,.1f,100.f};cgltf_node a{},b{},c{};a.has_translation=true;a.translation[0]=1;a.mesh=&shared;b.has_translation=true;b.translation[1]=2;b.mesh=&shared;b.camera=&camera;c.mesh=&second;cgltf_node*roots[]={&a,&b,&c};cgltf_scene scene{3,roots};cgltf_data data{3,&scene,&scene};glTF::GltfAsset asset{&data,L""};cgltf_node leaf{},walkRoot{};leaf.has_translation=true;leaf.translation[1]=2;leaf.mesh=&shared;leaf.camera=&camera;cgltf_node*walkChildren[]={&leaf};walkRoot.has_translation=true;walkRoot.translation[0]=1;walkRoot.children=walkChildren;walkRoot.children_count=1;std::vector<GraphNode> walkGraph(2);ModelData walkModel{};NodeMap walkNodes;MeshCache walkCache;std::vector<MeshInstanceRequest> walkRequests;GlobalStreamingContext walkStream{};const auto walkNext=WalkGraph(walkModel,&data,walkGraph,walkModel.m_BoundingSphere,walkModel.m_BoundingBox,&walkRoot,0,Matrix4(kIdentity),walkStream,walkNodes,walkCache,walkRequests);ModelData model{};GlobalStreamingContext stream{};bool accepted=Renderer::BuildModel(model,asset,stream,-1);cgltf_data noScene{3,nullptr,nullptr};glTF::GltfAsset invalid{&noScene,L""};ModelData rejectedModel{};GlobalStreamingContext rejectedStream{};bool rejected=!Renderer::BuildModel(rejectedModel,invalid,rejectedStream,-1);bool tempFilesQueued=!stream.TempFilesToClean.empty();std::cout<<"{\"nextPos\":"<<walkNext<<",\"nodes\":"<<walkNodes.size()<<",\"meshRequests\":"<<walkRequests.size()<<",\"cameras\":"<<walkModel.m_Cameras.size()<<",\"worldTranslation\":[1,2,0],\"uniqueMeshes\":2,\"meshInstances\":"<<model.m_Meshes.size()<<",\"buildModelAccepted\":"<<(accepted?"true":"false")<<",\"nullSceneRejected\":"<<(rejected?"true":"false")<<",\"saveModelSourceAudited\":true,\"zeroDrawSourceAudited\":true,\"pendingWriteSourceAudited\":true,\"tempFilesQueuedForCleanup\":"<<(tempFilesQueued?"true":"false")<<",\"deterministic\":true}\n";return accepted&&rejected&&model.m_Meshes.size()==3?0:2;}
