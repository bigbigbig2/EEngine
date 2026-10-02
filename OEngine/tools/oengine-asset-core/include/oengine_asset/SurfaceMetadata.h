#pragma once
#include "GeometryCooker.h"
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <numeric>
#include <set>
#include <string>
#include <stdexcept>

namespace oengine::asset {
constexpr std::uint32_t kSurfacePrimitiveBytes = 64u;
constexpr std::uint32_t kSurfaceDomainCount = 6u;
enum SurfaceIdentityRisk : std::uint32_t { kSurfaceDegenerate=1u, kSurfaceNonManifold=2u, kSurfaceLodLocal=4u };
enum SurfaceFieldRisk : std::uint32_t { kSurfaceNormalRisk=1u, kSurfaceTangentRisk=2u, kSurfaceUv0Risk=4u, kSurfaceUv1Risk=8u };
struct SurfacePrimitiveMetadata {
    std::uint32_t domains[kSurfaceDomainCount]{};
    std::uint32_t identityRisk=0u, fieldRisk=0u;
    float normalVariation=0, colorVariation=0;
    float uvSpan[4]{};
    float positionError=0, attributeError=0;
};
static_assert(sizeof(SurfacePrimitiveMetadata)==kSurfacePrimitiveBytes);
using SurfaceVertexLineage = std::array<std::set<std::uint32_t>, kSurfaceDomainCount>;
struct SourceSurfaceDomains {
    std::vector<SurfacePrimitiveMetadata> triangles;
    std::vector<SurfaceVertexLineage> vertices;
};
inline std::uint32_t SurfaceFloatBits(float value) {
    if (!std::isfinite(value)) throw std::runtime_error("Surface publication has non-finite attributes");
    std::uint32_t bits=0;if(value!=0)std::memcpy(&bits,&value,sizeof(bits));return bits;
}
inline std::string SurfacePositionKey(const CanonicalVertex& vertex) {
    const std::uint32_t bits[3]={SurfaceFloatBits(vertex.position[0]),SurfaceFloatBits(vertex.position[1]),SurfaceFloatBits(vertex.position[2])};
    return std::string(reinterpret_cast<const char*>(bits),sizeof(bits));
}
inline bool SurfaceEqual(const float* a,const float* b,std::uint32_t count) {
    for(std::uint32_t c=0;c<count;++c)if(SurfaceFloatBits(a[c])!=SurfaceFloatBits(b[c]))return false;
    return true;
}
inline int SurfaceOrientation(const CanonicalVertex& a,const CanonicalVertex& b,const CanonicalVertex& c,std::uint32_t uv) {
    const auto* x=uv?a.uv1:a.uv0;const auto* y=uv?b.uv1:b.uv0;const auto* z=uv?c.uv1:c.uv0;
    const double determinant=(double(y[0])-x[0])*(double(z[1])-x[1])-(double(y[1])-x[1])*(double(z[0])-x[0]);
    return determinant>0?1:determinant<0?-1:0;
}
inline float SurfaceRoundUp(double value) {
    float result=float(value);return double(result)<value?std::nextafter(result,std::numeric_limits<float>::infinity()):result;
}
inline SurfacePrimitiveMetadata SurfaceTriangleBounds(const CanonicalVertex& a,const CanonicalVertex& b,
    const CanonicalVertex& c,std::uint16_t mask) {
    SurfacePrimitiveMetadata result;const CanonicalVertex* vertices[3]={&a,&b,&c};
    double ab[3],ac[3],face[3];
    for(unsigned axis=0;axis<3;++axis){ab[axis]=double(b.position[axis])-a.position[axis];ac[axis]=double(c.position[axis])-a.position[axis];}
    for(unsigned axis=0;axis<3;++axis)face[axis]=ab[(axis+1)%3]*ac[(axis+2)%3]-ab[(axis+2)%3]*ac[(axis+1)%3];
    if(!(face[0]*face[0]+face[1]*face[1]+face[2]*face[2]>0))result.identityRisk|=kSurfaceDegenerate;
    double normalVariation=0,colorVariation=0,tangentAngle=0;
    for(unsigned i=0;i<3;++i){
        const auto& begin=*vertices[i];const auto& end=*vertices[(i+1)%3];double x=0,y=0,dot=0,tangent=0;
        for(unsigned axis=0;axis<3;++axis){x+=double(begin.normal[axis])*begin.normal[axis];y+=double(end.normal[axis])*end.normal[axis];dot+=double(begin.normal[axis])*end.normal[axis];tangent+=double(begin.tangent[axis])*begin.tangent[axis];}
        if(!(x>0&&y>0))result.fieldRisk|=kSurfaceNormalRisk;
        else normalVariation=std::max(normalVariation,1-std::clamp(dot/std::sqrt(x*y),-1.0,1.0));
        if(!(tangent>0)||std::abs(begin.tangent[3])!=1)result.fieldRisk|=kSurfaceTangentRisk;
        if(begin.tangent[3]!=end.tangent[3])result.fieldRisk|=kSurfaceTangentRisk;
        double endTangent=0,tangentDot=0;
        for(unsigned axis=0;axis<3;++axis){endTangent+=double(end.tangent[axis])*end.tangent[axis];tangentDot+=double(begin.tangent[axis])*end.tangent[axis];}
        if(tangent>0&&endTangent>0)tangentAngle=std::max(tangentAngle,std::acos(std::clamp(tangentDot/std::sqrt(tangent*endTangent),-1.0,1.0)));
        for(unsigned channel=0;channel<4;++channel)colorVariation=std::max(colorVariation,std::abs(double(begin.color[channel])-end.color[channel]));
    }
    result.normalVariation=SurfaceRoundUp(normalVariation);result.colorVariation=SurfaceRoundUp(colorVariation);
    const double pi=std::acos(-1.0);
    result.fieldRisk|=std::uint32_t(std::ceil(tangentAngle/pi*255.0))<<24u;
    for(unsigned uv=0;uv<2;++uv){
        const unsigned attribute=uv?kAttributeUv1:kAttributeUv0;
        if((mask&attribute)&&SurfaceOrientation(a,b,c,uv)==0)result.fieldRisk|=uv?kSurfaceUv1Risk:kSurfaceUv0Risk;
        for(unsigned axis=0;axis<2;++axis){
            double low=std::numeric_limits<double>::infinity(),high=-low;
            for(const auto* vertex:vertices){const float value=uv?vertex->uv1[axis]:vertex->uv0[axis];low=std::min(low,double(value));high=std::max(high,double(value));}
            result.uvSpan[uv*2+axis]=SurfaceRoundUp(high-low);
        }
    }
    return result;
}
/** Local Continuity-Domain builder: full-record equality is not geometry identity. */
inline SourceSurfaceDomains BuildSourceSurfaceDomains(const MaterialDomain& source,std::uint32_t domainBase=0u) {
    if(source.indices.size()%3u)throw std::runtime_error("Invalid Surface triangle count");
    const auto count=std::uint32_t(source.indices.size()/3u);
    if(std::uint64_t(domainBase)+count>=kInvalidId)throw std::runtime_error("Surface domain namespace exhausted");
    SourceSurfaceDomains result;result.triangles.resize(count);result.vertices.resize(source.vertices.size());
    std::array<std::vector<std::uint32_t>,kSurfaceDomainCount> parents;
    for(auto& field:parents){field.resize(count);std::iota(field.begin(),field.end(),0u);}
    auto root=[&](unsigned field,std::uint32_t triangle){
        auto& parent=parents[field];auto current=triangle;while(parent[current]!=current)current=parent[current];
        while(parent[triangle]!=triangle){auto next=parent[triangle];parent[triangle]=current;triangle=next;}return current;
    };
    auto join=[&](unsigned field,std::uint32_t a,std::uint32_t b){a=root(field,a);b=root(field,b);parents[field][std::max(a,b)]=std::min(a,b);};
    struct Edge{std::uint32_t triangle,begin,end;bool forward;};
    std::map<std::pair<std::string,std::string>,std::vector<Edge>> edges;
    std::vector<std::string> positions;positions.reserve(source.vertices.size());
    for(const auto& vertex:source.vertices){
        positions.push_back(SurfacePositionKey(vertex));
        for(float value:vertex.normal)SurfaceFloatBits(value);
        for(float value:vertex.tangent)SurfaceFloatBits(value);
        for(float value:vertex.uv0)SurfaceFloatBits(value);
        for(float value:vertex.uv1)SurfaceFloatBits(value);
        for(float value:vertex.color)SurfaceFloatBits(value);
    }
    for(std::uint32_t triangle=0;triangle<count;++triangle){
        const auto* indices=source.indices.data()+triangle*3u;
        for(unsigned corner=0;corner<3;++corner)if(indices[corner]>=source.vertices.size())throw std::runtime_error("Invalid Surface vertex index");
        result.triangles[triangle]=SurfaceTriangleBounds(source.vertices[indices[0]],source.vertices[indices[1]],source.vertices[indices[2]],source.attributeMask);
        for(unsigned corner=0;corner<3;++corner){
            const auto begin=indices[corner],end=indices[(corner+1)%3];auto a=positions[begin],b=positions[end];
            if(a==b)continue;
            const bool forward=a<b;
            if(!forward)std::swap(a,b);
            edges[{a,b}].push_back({triangle,begin,end,forward});
        }
    }
    for(const auto& [key,list]:edges){
        (void)key;
        if(list.size()!=2u||list[0].forward==list[1].forward){if(list.size()>1u)for(const auto& edge:list)result.triangles[edge.triangle].identityRisk|=kSurfaceNonManifold;continue;}
        const auto& x=list[0];const auto& y=list[1];
        if((result.triangles[x.triangle].identityRisk|result.triangles[y.triangle].identityRisk)&kSurfaceDegenerate)continue;
        join(0u,x.triangle,y.triangle);
        const auto& a=source.vertices[x.begin];const auto& b=source.vertices[x.end];const auto& c=source.vertices[y.end];const auto& d=source.vertices[y.begin];
        for(unsigned uv=0;uv<2;++uv){
            const auto* xi=source.indices.data()+x.triangle*3u;const auto* yi=source.indices.data()+y.triangle*3u;
            const int sx=SurfaceOrientation(source.vertices[xi[0]],source.vertices[xi[1]],source.vertices[xi[2]],uv),sy=SurfaceOrientation(source.vertices[yi[0]],source.vertices[yi[1]],source.vertices[yi[2]],uv);
            const unsigned attribute=uv?kAttributeUv1:kAttributeUv0;
            if((!(source.attributeMask&attribute)||(sx!=0&&sx==sy))&&SurfaceEqual(uv?a.uv1:a.uv0,uv?c.uv1:c.uv0,2)&&SurfaceEqual(uv?b.uv1:b.uv0,uv?d.uv1:d.uv0,2))join(uv+1,x.triangle,y.triangle);
        }
        const auto risk=result.triangles[x.triangle].fieldRisk|result.triangles[y.triangle].fieldRisk;
        if(!(risk&kSurfaceNormalRisk)&&SurfaceEqual(a.normal,c.normal,3)&&SurfaceEqual(b.normal,d.normal,3))join(3,x.triangle,y.triangle);
        if(!(risk&kSurfaceTangentRisk)&&SurfaceEqual(a.tangent,c.tangent,4)&&SurfaceEqual(b.tangent,d.tangent,4))join(4,x.triangle,y.triangle);
        if(SurfaceEqual(a.color,c.color,4)&&SurfaceEqual(b.color,d.color,4))join(5,x.triangle,y.triangle);
    }
    for(std::uint32_t triangle=0;triangle<count;++triangle)for(unsigned field=0;field<kSurfaceDomainCount;++field){
        const auto id=domainBase+root(field,triangle)+1u;result.triangles[triangle].domains[field]=id;
        for(unsigned corner=0;corner<3;++corner)result.vertices[source.indices[triangle*3u+corner]][field].insert(id);
    }
    return result;
}
inline void MergeSurfaceLineage(SurfaceVertexLineage& target,const SurfaceVertexLineage& source){
    for(unsigned field=0;field<kSurfaceDomainCount;++field)target[field].insert(source[field].begin(),source[field].end());
}
inline void InheritSurfaceLineage(SurfacePrimitiveMetadata& metadata,const SurfaceVertexLineage& a,const SurfaceVertexLineage& b,const SurfaceVertexLineage& c){
    for(unsigned field=0;field<kSurfaceDomainCount;++field){
        std::uint32_t id=0,count=0;for(auto candidate:a[field])if(b[field].count(candidate)&&c[field].count(candidate)){id=candidate;++count;}
        if(count==1u)metadata.domains[field]=id;else{metadata.identityRisk|=kSurfaceLodLocal;metadata.fieldRisk|=1u<<(16u+field);}
    }
}
}
