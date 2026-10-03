import type { CompiledAppearanceGraph } from "../material/AppearanceGraphCompiler.js";
import type { AppearanceWgslProgram } from "./appearance_program.js";
import { APPEARANCE_NORMAL_MIN_MOMENT_SQUARED } from "../material/AppearanceNormalFilter.js";
import { lowerAppearanceMaterialConstants } from "./appearance_material_constants.js";

/** Local interval propagation over the SAME compiled scalar graph. No texture
 * sampling, material value evaluation, dynamic node interpreter or role loop.
 * The owner supplies constants/input/texture/product bounds callbacks. Unknown
 * is local to the reachable output; it never invalidates the whole material.
 * Arithmetic envelopes include f32 rounding. Elementary functions have their
 * own validity/error domains; unbounded implementation-defined accuracy becomes
 * unknown for that output. Publication leaves and multiply-by-zero stay exact. */
export const APPEARANCE_FIELD_BOUND_WGSL = /* wgsl */ `
struct AppearanceBound {low:f32,high:f32,known:u32,}
struct AppearanceBound4 {low:vec4f,high:vec4f,known:vec4u,}
fn ab_unknown()->AppearanceBound{return AppearanceBound(0.0,0.0,0u);}
fn ab_exact(value:f32)->AppearanceBound{return AppearanceBound(value,value,1u);}
fn ab_valid(a:AppearanceBound)->bool{return a.known!=0u && a.low<=a.high && all(vec2f(a.low,a.high)==vec2f(a.low,a.high));}
fn ab_expand(low:f32,high:f32)->AppearanceBound {
 let valid = low <= high && all(abs(vec2f(low,high)) <= vec2f(1e30));
 let margin=max(abs(vec2f(low,high))*4.76837158203125e-7,vec2f(1e-30));
 return AppearanceBound(select(0.0,low-margin.x,valid),select(0.0,high+margin.y,valid),u32(valid));
}
// Keep interval arithmetic straight-line. Inlining repeated early-return
// branches through a material graph otherwise expands the driver compiler CFG
// dramatically. Invalid intervals retain the exact same unknown result.
fn ab_checked(value:AppearanceBound,valid:bool)->AppearanceBound {
 return AppearanceBound(select(0.0,value.low,valid),select(0.0,value.high,valid),select(0u,value.known,valid));
}
fn ab_channel(a:AppearanceBound4,c:u32)->AppearanceBound{return AppearanceBound(a.low[c],a.high[c],a.known[c]);}
fn ab_add(a:AppearanceBound,b:AppearanceBound)->AppearanceBound {
 return ab_checked(ab_expand(a.low+b.low,a.high+b.high),ab_valid(a)&&ab_valid(b));
}
fn ab_subtract(a:AppearanceBound,b:AppearanceBound)->AppearanceBound {
 return ab_checked(ab_expand(a.low-b.high,a.high-b.low),ab_valid(a)&&ab_valid(b));
}
fn ab_multiply(a:AppearanceBound,b:AppearanceBound)->AppearanceBound {
 let zero = (ab_valid(a)&&a.low==0.0&&a.high==0.0)||(ab_valid(b)&&b.low==0.0&&b.high==0.0);
 let products=vec4f(a.low*b.low,a.low*b.high,a.high*b.low,a.high*b.high);
 let result=ab_checked(ab_expand(min(min(products.x,products.y),min(products.z,products.w)),max(max(products.x,products.y),max(products.z,products.w))),ab_valid(a)&&ab_valid(b));
 return AppearanceBound(select(result.low,0.0,zero),select(result.high,0.0,zero),select(result.known,1u,zero));
}
fn ab_divide(a:AppearanceBound,b:AppearanceBound)->AppearanceBound {
 let valid=ab_valid(a)&&ab_valid(b)&&!(b.low<=0.0&&b.high>=0.0);
 // Avoid executing singular divisions even when the final interval is unknown.
 let divisor=select(vec2f(1.0),vec2f(b.high,b.low),vec2<bool>(valid));
 return ab_checked(ab_multiply(a,ab_expand(1.0/divisor.x,1.0/divisor.y)),valid);
}
fn ab_min(a:AppearanceBound,b:AppearanceBound)->AppearanceBound {
 if !ab_valid(a)||!ab_valid(b){return ab_unknown();}return AppearanceBound(min(a.low,b.low),min(a.high,b.high),1u);
}
fn ab_max(a:AppearanceBound,b:AppearanceBound)->AppearanceBound {
 if !ab_valid(a)||!ab_valid(b){return ab_unknown();}return AppearanceBound(max(a.low,b.low),max(a.high,b.high),1u);
}
fn ab_clamp(a:AppearanceBound,b:AppearanceBound,c:AppearanceBound)->AppearanceBound {
 if !ab_valid(a)||!ab_valid(b)||!ab_valid(c)||b.high>c.low{return ab_unknown();}
 return ab_min(ab_max(a,b),c);
}
fn ab_mix(a:AppearanceBound,b:AppearanceBound,c:AppearanceBound)->AppearanceBound {
 return ab_add(ab_multiply(a,ab_subtract(ab_exact(1.0),c)),ab_multiply(b,c));
}
fn ab_abs(a:AppearanceBound)->AppearanceBound {
 if !ab_valid(a){return ab_unknown();}
 return AppearanceBound(select(min(abs(a.low),abs(a.high)),0.0,a.low<=0.0&&a.high>=0.0),max(abs(a.low),abs(a.high)),1u);
}
fn ab_square(a:AppearanceBound)->AppearanceBound {
 let magnitude=ab_abs(a);if !ab_valid(magnitude){return ab_unknown();}
 var result=ab_expand(magnitude.low*magnitude.low,magnitude.high*magnitude.high);result.low=max(0.0,result.low);return result;
}
fn ab_sqrt(a:AppearanceBound)->AppearanceBound {
 if !ab_valid(a)||a.low<0.0{return ab_unknown();}var r=ab_expand(sqrt(a.low),sqrt(a.high));r.low=max(0.0,r.low);return r;
}
fn ab_pow(a:AppearanceBound,b:AppearanceBound)->AppearanceBound {
 // GLSL/WGSL pow is undefined for negative bases. A zero with a nonpositive
 // exponent is singular. Reject that output instead of inventing a finite bound.
 if !ab_valid(a)||!ab_valid(b)||a.low<0.0||(a.low==0.0&&b.low<=0.0){return ab_unknown();}
 // Only bounded integer exponents have an arithmetic certificate independent
 // of driver log/exp accuracy. Production value evaluation still uses pow.
 if b.low!=b.high||b.low!=floor(b.low)||abs(b.low)>8.0{return ab_unknown();}
 var result=ab_exact(1.0);for(var i=0u;i<u32(abs(b.low));i++){result=ab_multiply(result,a);}
 if b.low<0.0{return ab_divide(ab_exact(1.0),result);}return result;
}
fn ab_sin(a:AppearanceBound)->AppearanceBound {
 if !ab_valid(a){return ab_unknown();}
 // Large f32 argument reduction cannot establish phase from this envelope.
 if a.high-a.low>=6.28318530718 || max(abs(a.low),abs(a.high))>3.14159265359{return AppearanceBound(-1.0,1.0,1u);}
 var low=min(sin(a.low),sin(a.high));var high=max(sin(a.low),sin(a.high));
 if ceil((a.low-1.57079632679)/6.28318530718)<=floor((a.high-1.57079632679)/6.28318530718){high=1.0;}
 if ceil((a.low+1.57079632679)/6.28318530718)<=floor((a.high+1.57079632679)/6.28318530718){low=-1.0;}
 // WGSL's sine error on [-pi,pi] is absolute, not an f32 relative-ULP promise.
 return AppearanceBound(max(-1.0,low-0.00048828125),min(1.0,high+0.00048828125),1u);
}
fn ab_cos(a:AppearanceBound)->AppearanceBound {
 if !ab_valid(a){return ab_unknown();}
 if max(abs(a.low),abs(a.high))>3.14159265359{return AppearanceBound(-1.0,1.0,1u);}
 var low=min(cos(a.low),cos(a.high));var high=max(cos(a.low),cos(a.high));
 if a.low<=0.0&&a.high>=0.0{high=1.0;}
 return AppearanceBound(max(-1.0,low-0.00048828125),min(1.0,high+0.00048828125),1u);
}
fn ab_gradient_multiply(a:AppearanceBound,da:AppearanceBound,b:AppearanceBound,db:AppearanceBound)->AppearanceBound {
 return ab_add(ab_add(ab_multiply(a,db),ab_multiply(b,da)),ab_multiply(da,db));
}
fn ab_gradient_divide(a:AppearanceBound,da:AppearanceBound,b:AppearanceBound,db:AppearanceBound)->AppearanceBound {
 return ab_divide(ab_subtract(ab_multiply(da,b),ab_multiply(a,db)),ab_multiply(b,ab_add(b,db)));
}
fn ab_normal_product(moment:AppearanceBound4,c:u32)->AppearanceBound {
 let x=ab_channel(moment,0u);let y=ab_channel(moment,1u);let z=ab_channel(moment,2u);
 let raw=ab_add(ab_add(ab_square(x),ab_square(y)),ab_square(z));
 if !ab_valid(raw){return ab_unknown();}
 if raw.high<=${APPEARANCE_NORMAL_MIN_MOMENT_SQUARED}{return ab_exact(select(0.0,1.0,c==2u||c==3u));}
 if raw.low<=${APPEARANCE_NORMAL_MIN_MOMENT_SQUARED}{return ab_unknown();}
 if c<3u{return ab_divide(ab_channel(moment,c),ab_sqrt(raw));}
 if c==4u{return ab_exact(1.0);}
 let r2=ab_min(raw,ab_exact(1.0));
 let inv_lambda=ab_divide(ab_subtract(ab_exact(1.0),r2),ab_multiply(ab_sqrt(r2),ab_subtract(ab_exact(3.0),r2)));
 var variance=ab_min(ab_multiply(ab_exact(2.0),inv_lambda),ab_exact(1.0));variance.low=max(0.0,variance.low);
 return ab_sqrt(ab_sqrt(variance));
}
`;

export interface AppearanceFieldBoundProgram {
  /** Production geometry semantics in program input order, fixed at publication. */
  readonly inputSemantics?: readonly number[];
  readonly source: string;
  readonly fields: readonly string[];
  readonly materialSource: string;
  /** Complete closure per output: used for field-specific seam compatibility. */
  readonly inputKinds: Readonly<Record<string, readonly string[]>>;
  readonly supported: Readonly<Record<string, boolean>>;
}

/** Generated function signature: ab_field_N(field:u32,context:vec4u)->AppearanceBound4.
 * context belongs to the Geometry/Appearance integration (setup + rectangle),
 * never a CPU-selected per-frame task. Integration callbacks are mandatory. */
export function lowerAppearanceFieldBounds(program: CompiledAppearanceGraph, lowered: AppearanceWgslProgram,
  functionName = "ab_field"): AppearanceFieldBoundProgram {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(functionName)) throw new RangeError("Invalid bound function name");
  const inputs = new Map(program.inputs.map((input, index) => [input.name, index]));
  const coordinateAncestors = new Set<number>(), coordinatePending = [
    ...program.samples.flatMap(sample => sample.uv),
    ...(program.productReads ?? []).flatMap(read => read.uv ?? [])
  ];
  while (coordinatePending.length) { const ref=coordinatePending.pop()!;if(coordinateAncestors.has(ref))continue;
    coordinateAncestors.add(ref);coordinatePending.push(...program.instructions[ref]!.args); }
  const kinds: Record<string, readonly string[]> = Object.create(null), supported: Record<string, boolean> = Object.create(null);
  const blocks: string[] = [];
  for (const [field, roots] of Object.entries(program.outputs)) {
    const live = new Set<number>(), pending = [...roots];
    while (pending.length) { const id = pending.pop()!; if (live.has(id)) continue; live.add(id); pending.push(...program.instructions[id]!.args); }
    kinds[field] = Object.freeze([...new Set([...live].flatMap(id => {
      const instruction = program.instructions[id]!; return instruction.kind === "input" ? [instruction.input!] : [];
    }))]);
    supported[field] = true;
    const declarations: string[] = [], textures = new Set<number>(), products = new Set<number>();
    for (let id = 0; id < program.instructions.length; id++) {
      if (!live.has(id)) continue;
      const instruction = program.instructions[id]!;
      const expr = (ref: number): string => `b${ref}`;
      let value: string;
      if (instruction.kind === "constant" || instruction.kind === "parameter") {
        const slot = lowered.instructionConstantSlots[id]!;
        if (slot < 0) throw new Error("Appearance bound/evaluation constant layout mismatch");
        value = `ab_exact(ab_constant(context,${slot}u))`;
      } else if (instruction.kind === "input") {
        const input = program.inputs[inputs.get(instruction.input!)!]!;
        // Nonlocal/dynamic inputs do not have a spatial envelope. Their output
        // alone is unknown; an unrelated stable field still gets a coarse plan.
        if (input.domain === "dynamic" || input.domain === "nonlocal") { value = "ab_unknown()"; supported[field] = false; }
        else value = `ab_input(context,${inputs.get(instruction.input!)}u,${instruction.channel}u)`;
      } else if (instruction.kind === "texture") {
        const sample = instruction.sample!, uv = program.samples[sample]!.uv;
        if (!textures.has(sample)) { declarations.push(`let t${sample}=ab_texture(context,${sample}u,${expr(uv[0])},${expr(uv[1])},d${uv[0]}x,d${uv[0]}y,d${uv[1]}x,d${uv[1]}y);`); textures.add(sample); }
        value = `ab_channel(t${sample},${instruction.channel}u)`;
      } else if (instruction.kind === "product" || instruction.kind === "normal-product") {
        const product = instruction.product!, read = program.productReads![product]!;
        if (!products.has(product)) {
          if (read.field.constant !== undefined) {
            const slots = lowered.productConstantSlots[product];
            if (!slots) throw new Error("Appearance product bound/evaluation constant layout mismatch");
            const values = Array.from({ length: 4 }, (_, c) => c < slots.length ? `ab_constant(context,${slots[c]}u)` : "0.0").join(",");
            declarations.push(`let p${product}=AppearanceBound4(vec4f(${values}),vec4f(${values}),vec4u(1u));`);
          } else declarations.push(`let p${product}=ab_product(context,${product}u,${expr(read.uv![0])},${expr(read.uv![1])},d${read.uv![0]}x,d${read.uv![0]}y,d${read.uv![1]}x,d${read.uv![1]}y);`);
          products.add(product);
        }
        value = instruction.kind === "normal-product" ? `ab_normal_product(p${product},${instruction.channel}u)` : `ab_channel(p${product},${instruction.channel}u)`;
      } else value = `ab_${instruction.op}(${instruction.args.map(expr).join(",")})`;
      declarations.push(`let b${id}=${value};`);
      if (coordinateAncestors.has(id)) for (const axis of ["x","y"] as const) {
        let derivative="ab_unknown()";
        if (instruction.kind === "constant" || instruction.kind === "parameter") derivative="ab_exact(0.0)";
        else if(instruction.kind === "input") {
          const domain=program.inputs[inputs.get(instruction.input!)!]!.domain;
          if(domain!=="dynamic"&&domain!=="nonlocal")derivative=`ab_input_gradient(context,${inputs.get(instruction.input!)}u,${instruction.channel}u,${axis==="x"?0:1}u)`;
        } else if(instruction.kind === "operation") {
          const [a,b]=instruction.args;
          if(instruction.op==="add"||instruction.op==="subtract")derivative=`ab_${instruction.op}(d${a}${axis},d${b}${axis})`;
          else if(instruction.op==="multiply"||instruction.op==="divide")derivative=`ab_gradient_${instruction.op}(b${a},d${a}${axis},b${b},d${b}${axis})`;
        }
        // Texture-driven/discrete nonlinear coordinates have no certified
        // derivative in this profile; only their dependent sampled output fails.
        declarations.push(`let d${id}${axis}=${derivative};`);
      }
    }
    const channels = Array.from({ length: 4 }, (_, c) => roots[c] === undefined ? "ab_exact(0.0)" : `b${roots[c]}`);
    blocks.push(`case ${blocks.length}u:{\n${declarations.join("\n")}\nreturn AppearanceBound4(vec4f(${channels.map(c=>`${c}.low`).join(",")}),vec4f(${channels.map(c=>`${c}.high`).join(",")}),vec4u(${channels.map(c=>`${c}.known`).join(",")}));}`);
  }
  const source = `fn ${functionName}(field:u32,context:vec4u)->AppearanceBound4 {switch field {\n${blocks.join("\n")}\ndefault:{return AppearanceBound4(vec4f(0.0),vec4f(0.0),vec4u(0u));}\n}}`;
  return Object.freeze({ source, materialSource: lowerAppearanceMaterialConstants(program,lowered,`${functionName}_material`),
    fields: Object.freeze(Object.keys(program.outputs)), inputKinds: Object.freeze(kinds), supported: Object.freeze(supported) });
}
