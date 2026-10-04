import test from 'node:test';
import assert from 'node:assert/strict';
import { surfaceCellProductionFactsWgsl } from '../../.test-dist/shaders/surface_cell_production_facts.js';

function program(fields) {
  return {
    fields, materialSource: 'fn ab_field_0_material(context:vec4u)->MaterialConstantResult {var result:MaterialConstantResult;result.values[0]=vec4f(f32(context.z));return result;}', inputKinds: {}, supported: {}, inputSemantics: [1, 4],
    dependencyProfiles:Object.fromEntries(fields.map((field,index)=>[field,{inputs:[{index,channel:0,domain:'geometry'}],samples:[],products:[],dependencyMask:1,supported:true}])),
    source: `fn ab_field_0(field:u32,context:vec4u)->AppearanceBound4 { switch field {
      case 0u:{let ordinal_zero=ab_input(context,0u,0u);return AppearanceBound4(vec4f(ordinal_zero.low),vec4f(ordinal_zero.high),vec4u(ordinal_zero.known));}
      case 1u:{let ordinal_one=ab_input(context,1u,0u);return AppearanceBound4(vec4f(ordinal_one.low),vec4f(ordinal_one.high),vec4u(ordinal_one.known));}
      default:{return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u));}
    }}`
  };
}
function body(fields, selected) {
  const source = surfaceCellProductionFactsWgsl([program(fields)], false, 'fn cell_direct_group_safe() {}', null, 16, new Set(selected), false);
  return source.slice(source.indexOf('fn ab_field_0('), source.indexOf('fn cell_constant_palette('));
}
test('bound stages translate Surface fields into sparse program output ordinals', () => {
  const source = body(['roughness', 'baseColor'], [0]);
  assert.doesNotMatch(source, /ordinal_zero/);
  assert.match(source, /case 1u:/);
  assert.ok(source.includes('cell_input_value_kind(4u,0u)'));
  assert.ok(!source.includes('ab_input('));
});
test('an absent field does not retain every unrelated graph output', () => {
  const source = body(['roughness', 'baseColor'], [10]);
  assert.doesNotMatch(source, /ordinal_zero|ordinal_one/);
  assert.match(source, /default:/);
});
test('field stage selection is independent of graph output order', () => {
  const source = body(['roughness', 'baseColor'], [3]);
  assert.match(source, /ordinal_zero/);
  assert.doesNotMatch(source, /ordinal_one/);
  assert.ok(source.includes('cell_input_value_kind(1u,0u)'));
});
test('equal bound code shares a function while each call retains its material context',()=>{
  const first=program(['roughness','baseColor']);
  const second={...first,source:first.source.replace('fn ab_field_0(','fn ab_field_1('),
    materialSource:first.materialSource.replace('fn ab_field_0_material(','fn ab_field_1_material(')};
  const source=surfaceCellProductionFactsWgsl([first,second],false,'fn cell_direct_group_safe() {}',null,16,new Set([0]),false);
  assert.ok(source.includes('fn ab_field_0('));
  assert.ok(!source.includes('fn ab_field_1('));
  assert.ok(source.includes('case 0u, 1u:{return ab_field_0(descriptor.x,context);}'));
  assert.ok(source.includes('case 0u, 1u:{result=ab_field_0_material(context);}'));
  assert.ok(!source.includes('fn ab_field_1_material('));
  assert.ok(source.includes('result.values[0]=vec4f(f32(context.z))'));
});
