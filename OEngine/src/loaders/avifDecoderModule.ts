/**
 * avifDecoderModule：负责资源读取、解码或场景装载。
 */

// @ts-nocheck
var Uo,
  Go =
    ((Uo = import.meta.url),
    function (e = {}) {
      var t,
        n,
        r = e,
        s = new Promise((e, r) => {
          ((t = e), (n = r));
        }),
        a = "object" == typeof window,
        i = "undefined" != typeof WorkerGlobalScope;
      "object" == typeof process &&
        "object" == typeof process.versions &&
        "string" == typeof process.versions.node &&
        process;
      const o =
          void 0 !== globalThis.ServiceWorkerGlobalScope &&
          "undefined" != typeof self &&
          globalThis.caches &&
          void 0 !== globalThis.caches.default,
        _ = "object" == typeof process && process.release && "node" === process.release.name;
      (o || _) &&
        (globalThis.ImageData ||
          (globalThis.ImageData = class {
            constructor(e, t, n) {
              ((this.data = e), (this.width = t), (this.height = n));
            }
          }),
        void 0 === import.meta.url && (import.meta.url = "https://localhost"),
        "undefined" != typeof self && void 0 === self.location && (self.location = { href: "" }));
      var c,
        d,
        u = Object.assign({}, r),
        l = (e, t) => {
          throw t;
        },
        f = "";
      (a || i) &&
        (i
          ? (f = self.location.href)
          : "undefined" != typeof document &&
            document.currentScript &&
            (f = document.currentScript.src),
        Uo && (f = Uo),
        (f = f.startsWith("blob:")
          ? ""
          : f.substr(0, f.replace(/[?#].*/, "").lastIndexOf("/") + 1)),
        i &&
          (d = (e) => {
            var t = new XMLHttpRequest();
            return (
              t.open("GET", e, !1),
              (t.responseType = "arraybuffer"),
              t.send(null),
              new Uint8Array(t.response)
            );
          }),
        (c = async (e) => {
          var t = await fetch(e, { credentials: "same-origin" });
          if (t.ok) return t.arrayBuffer();
          throw new Error(t.status + " : " + t.url);
        }));
      var h = r.print || console.log.bind(console),
        m = r.printErr || console.error.bind(console);
      (Object.assign(r, u), (u = null));
      var g,
        p,
        v,
        A,
        b,
        w,
        x,
        y,
        B,
        P,
        z = r.wasmBinary,
        E = !1;
      function C() {
        var e = g.buffer;
        ((r.HEAP8 = v = new Int8Array(e)),
          (r.HEAP16 = b = new Int16Array(e)),
          (r.HEAPU8 = A = new Uint8Array(e)),
          (r.HEAPU16 = w = new Uint16Array(e)),
          (r.HEAP32 = x = new Int32Array(e)),
          (r.HEAPU32 = y = new Uint32Array(e)),
          (r.HEAPF32 = B = new Float32Array(e)),
          (r.HEAPF64 = P = new Float64Array(e)));
      }
      var D = [],
        Q = [],
        k = [];
      function I(e) {
        D.unshift(e);
      }
      function F(e) {
        k.unshift(e);
      }
      var M = 0,
        j = null;
      function T(e) {
        (r.onAbort?.(e),
          m((e = "Aborted(" + e + ")")),
          (E = !0),
          (e += ". Build with -sASSERTIONS for more info."));
        var t = new WebAssembly.RuntimeError(e);
        throw (n(t), t);
      }
      var L,
        U = (e) => e.startsWith("data:application/octet-stream;base64,");
      class G {
        name = "ExitStatus";
        constructor(e) {
          ((this.message = `Program terminated with exit(${e})`), (this.status = e));
        }
      }
      var H,
        O,
        S,
        R = (e) => {
          for (; e.length > 0;) e.shift()(r);
        },
        q = r.noExitRuntime || !0,
        N = (e) => {
          for (var t = "", n = e; A[n];) t += H[A[n++]];
          return t;
        },
        Y = {},
        X = {},
        J = {},
        K = (e) => {
          throw new O(e);
        },
        V = (e) => {
          throw new S(e);
        };
      function $(e, t, n = {}) {
        return ((e, t, n = {}) => {
          var r = t.name;
          if (
            (e || K(`type "${r}" must have a positive integer typeid pointer`), X.hasOwnProperty(e))
          ) {
            if (n.ignoreDuplicateRegistrations) return;
            K(`Cannot register type '${r}' twice`);
          }
          if (((X[e] = t), delete J[e], Y.hasOwnProperty(e))) {
            var s = Y[e];
            (delete Y[e], s.forEach((e) => e()));
          }
        })(e, t, n);
      }
      var W = [],
        Z = [],
        ee = (e) => {
          e > 9 && 0 === --Z[e + 1] && ((Z[e] = void 0), W.push(e));
        },
        te = (e) => (e || K("Cannot use deleted val. handle = " + e), Z[e]),
        ne = (e) => {
          switch (e) {
            case void 0:
              return 2;
            case null:
              return 4;
            case !0:
              return 6;
            case !1:
              return 8;
            default: {
              const t = W.pop() || Z.length;
              return ((Z[t] = e), (Z[t + 1] = 1), t);
            }
          }
        };
      function re(e) {
        return this.fromWireType(y[e >> 2]);
      }
      var se,
        ae,
        ie,
        oe,
        _e = {
          name: "emscripten::val",
          fromWireType(e) {
            var t = te(e);
            return (ee(e), t);
          },
          toWireType: (e, t) => ne(t),
          argPackAdvance: 8,
          readValueFromPointer: re,
          destructorFunction: null
        },
        ce = (e, t) => {
          switch (t) {
            case 4:
              return function (e) {
                return this.fromWireType(B[e >> 2]);
              };
            case 8:
              return function (e) {
                return this.fromWireType(P[e >> 3]);
              };
            default:
              throw new TypeError(`invalid float width (${t}): ${e}`);
          }
        },
        de = (e, t) => Object.defineProperty(t, "name", { value: e }),
        ue = (e) => {
          for (; e.length;) {
            var t = e.pop();
            e.pop()(t);
          }
        },
        le = (e, t, n) => {
          if (void 0 === e[t].overloadTable) {
            var r = e[t];
            ((e[t] = function (...r) {
              return (
                e[t].overloadTable.hasOwnProperty(r.length) ||
                  K(
                    `Function '${n}' called with an invalid number of arguments (${r.length}) - expects one of (${e[t].overloadTable})!`
                  ),
                e[t].overloadTable[r.length].apply(this, r)
              );
            }),
              (e[t].overloadTable = []),
              (e[t].overloadTable[r.argCount] = r));
          }
        },
        fe = [],
        he = (e) => {
          var t = fe[e];
          return (t || (e >= fe.length && (fe.length = e + 1), (fe[e] = t = se.get(e))), t);
        },
        me = (e) => {
          var t = qe(e),
            n = N(t);
          return (Ye(t), n);
        },
        ge = (e, t, n) => {
          switch (t) {
            case 1:
              return n ? (e) => v[e] : (e) => A[e];
            case 2:
              return n ? (e) => b[e >> 1] : (e) => w[e >> 1];
            case 4:
              return n ? (e) => x[e >> 2] : (e) => y[e >> 2];
            default:
              throw new TypeError(`invalid integer width (${t}): ${e}`);
          }
        },
        pe = (e, t = 0, n = NaN) => {
          for (var r = t + n, s = ""; !(t >= r);) {
            var a = e[t++];
            if (!a) return s;
            if (128 & a) {
              var i = 63 & e[t++];
              if (192 != (224 & a)) {
                var o = 63 & e[t++];
                if (
                  (a =
                    224 == (240 & a)
                      ? ((15 & a) << 12) | (i << 6) | o
                      : ((7 & a) << 18) | (i << 12) | (o << 6) | (63 & e[t++])) < 65536
                )
                  s += String.fromCharCode(a);
                else {
                  var _ = a - 65536;
                  s += String.fromCharCode(55296 | (_ >> 10), 56320 | (1023 & _));
                }
              } else s += String.fromCharCode(((31 & a) << 6) | i);
            } else s += String.fromCharCode(a);
          }
          return s;
        },
        ve = (e, t) => (e ? pe(A, e, t) : ""),
        Ae = (e, t) => {
          for (var n = "", r = 0; !(r >= t / 2); ++r) {
            var s = b[(e + 2 * r) >> 1];
            if (0 == s) break;
            n += String.fromCharCode(s);
          }
          return n;
        },
        be = (e, t, n) => {
          if (((n ??= 2147483647), n < 2)) return 0;
          for (var r = t, s = (n -= 2) < 2 * e.length ? n / 2 : e.length, a = 0; a < s; ++a) {
            var i = e.charCodeAt(a);
            ((b[t >> 1] = i), (t += 2));
          }
          return ((b[t >> 1] = 0), t - r);
        },
        we = (e) => 2 * e.length,
        xe = (e, t) => {
          for (var n = 0, r = ""; !(n >= t / 4);) {
            var s = x[(e + 4 * n) >> 2];
            if (0 == s) break;
            if ((++n, s >= 65536)) {
              var a = s - 65536;
              r += String.fromCharCode(55296 | (a >> 10), 56320 | (1023 & a));
            } else r += String.fromCharCode(s);
          }
          return r;
        },
        ye = (e, t, n) => {
          if (((n ??= 2147483647), n < 4)) return 0;
          for (var r = t, s = r + n - 4, a = 0; a < e.length; ++a) {
            var i = e.charCodeAt(a);
            if (
              (i >= 55296 &&
                i <= 57343 &&
                (i = (65536 + ((1023 & i) << 10)) | (1023 & e.charCodeAt(++a))),
              (x[t >> 2] = i),
              (t += 4) + 4 > s)
            )
              break;
          }
          return ((x[t >> 2] = 0), t - r);
        },
        Be = (e) => {
          for (var t = 0, n = 0; n < e.length; ++n) {
            var r = e.charCodeAt(n);
            (r >= 55296 && r <= 57343 && ++n, (t += 4));
          }
          return t;
        },
        Pe = 0,
        ze = (e, t) => {
          var n = X[e];
          return (void 0 === n && K(`${t} has unknown type ${me(e)}`), n);
        },
        Ee = (e, t, n) => {
          var r = [],
            s = e.toWireType(r, n);
          return (r.length && (y[t >> 2] = ne(r)), s);
        },
        Ce = [],
        De = {},
        Qe = (e) => {
          var t = De[e];
          return void 0 === t ? N(e) : t;
        },
        ke = () => {
          if ("object" == typeof globalThis) return globalThis;
          function e(e) {
            e.$$$embind_global$$$ = e;
            var t = "object" == typeof $$$embind_global$$$ && e.$$$embind_global$$$ == e;
            return (t || delete e.$$$embind_global$$$, t);
          }
          if ("object" == typeof $$$embind_global$$$) return $$$embind_global$$$;
          if (
            ("object" == typeof global && e(global)
              ? ($$$embind_global$$$ = global)
              : "object" == typeof self && e(self) && ($$$embind_global$$$ = self),
            "object" == typeof $$$embind_global$$$)
          )
            return $$$embind_global$$$;
          throw Error("unable to get global object.");
        },
        Ie = Reflect.construct,
        Fe = {},
        Me = (e) => {
          if (e instanceof G || "unwind" == e) return p;
          l(0, e);
        },
        je = () => q || Pe > 0,
        Te = (e) => {
          ((p = e), je() || (r.onExit?.(e), (E = !0)), l(0, new G(e)));
        },
        Le = (e, t) => Math.ceil(e / t) * t,
        Ue = (e) => {
          var t = ((e - g.buffer.byteLength + 65535) / 65536) | 0;
          try {
            return (g.grow(t), C(), 1);
          } catch (e) {}
        },
        Ge = [null, [], []],
        He = (e, t) => {
          var n = Ge[e];
          0 === t || 10 === t ? ((1 === e ? h : m)(pe(n)), (n.length = 0)) : n.push(t);
        };
      ((() => {
        for (var e = new Array(256), t = 0; t < 256; ++t) e[t] = String.fromCharCode(t);
        H = e;
      })(),
        (O = r.BindingError =
          class extends Error {
            constructor(e) {
              (super(e), (this.name = "BindingError"));
            }
          }),
        (S = r.InternalError =
          class extends Error {
            constructor(e) {
              (super(e), (this.name = "InternalError"));
            }
          }),
        Z.push(0, 1, void 0, 1, null, 1, !0, 1, !1, 1),
        (r.count_emval_handles = () => Z.length / 2 - 5 - W.length),
        (ae = r.UnboundTypeError =
          ((ie = Error),
          (oe = de("UnboundTypeError", function (e) {
            ((this.name = "UnboundTypeError"), (this.message = e));
            var t = new Error(e).stack;
            void 0 !== t &&
              (this.stack = this.toString() + "\n" + t.replace(/^Error(:[^\n]*)?\n/, ""));
          })),
          (oe.prototype = Object.create(ie.prototype)),
          (oe.prototype.constructor = oe),
          (oe.prototype.toString = function () {
            return void 0 === this.message ? this.name : `${this.name}: ${this.message}`;
          }),
          oe)));
      var Oe,
        Se = {
          C: () => T(""),
          u(e, t, n, r, s) {},
          r(e, t, n, r) {
            $(e, {
              name: (t = N(t)),
              fromWireType: (e) => !!e,
              toWireType: (e, t) => (t ? n : r),
              argPackAdvance: 8,
              readValueFromPointer(e) {
                return this.fromWireType(A[e]);
              },
              destructorFunction: null
            });
          },
          p: (e) => $(e, _e),
          o(e, t, n) {
            $(e, {
              name: (t = N(t)),
              fromWireType: (e) => e,
              toWireType: (e, t) => t,
              argPackAdvance: 8,
              readValueFromPointer: ce(t, n),
              destructorFunction: null
            });
          },
          m(e, t, n, s, a, i, o, _) {
            var c = ((e, t) => {
              for (var n = [], r = 0; r < e; r++) n.push(y[(t + 4 * r) >> 2]);
              return n;
            })(t, n);
            ((e = ((e) => {
              const t = (e = e.trim()).indexOf("(");
              return -1 !== t ? e.substr(0, t) : e;
            })((e = N(e)))),
              (a = ((e, t) => {
                var n,
                  s,
                  a = (e = N(e)).includes("j")
                    ? ((n = e),
                      (s = t),
                      (...e) =>
                        ((e, t, n = []) =>
                          e.includes("j")
                            ? ((e, t, n) => (
                                (e = e.replace(/p/g, "i")),
                                (0, r["dynCall_" + e])(t, ...n)
                              ))(e, t, n)
                            : he(t)(...n))(n, s, e))
                    : he(t);
                return (
                  "function" != typeof a && K(`unknown function pointer with signature ${e}: ${t}`),
                  a
                );
              })(s, a)),
              ((e, t, n) => {
                r.hasOwnProperty(e)
                  ? ((void 0 === n ||
                      (void 0 !== r[e].overloadTable && void 0 !== r[e].overloadTable[n])) &&
                      K(`Cannot register public name '${e}' twice`),
                    le(r, e, e),
                    r[e].overloadTable.hasOwnProperty(n) &&
                      K(
                        `Cannot register multiple overloads of a function with the same number of arguments (${n})!`
                      ),
                    (r[e].overloadTable[n] = t))
                  : ((r[e] = t), (r[e].argCount = n));
              })(
                e,
                () => {
                  ((e, t) => {
                    var n = [],
                      r = {};
                    throw (
                      t.forEach(function e(t) {
                        r[t] || X[t] || (J[t] ? J[t].forEach(e) : (n.push(t), (r[t] = !0)));
                      }),
                      new ae(`${e}: ` + n.map(me).join([", "]))
                    );
                  })(`Cannot call ${e} due to unbound types`, c);
                },
                t - 1
              ),
              ((n, s) => {
                function o(s) {
                  var o = ((n) => {
                    var s = [n[0], null].concat(n.slice(1));
                    return (
                      ((e, t, n) => {
                        (r.hasOwnProperty(e) || V("Replacing nonexistent public symbol"),
                          void 0 !== r[e].overloadTable && void 0 !== n
                            ? (r[e].overloadTable[n] = t)
                            : ((r[e] = t), (r[e].argCount = n)));
                      })(
                        e,
                        ((e, t, n, r, s) => {
                          var a = t.length;
                          a < 2 &&
                            K(
                              "argTypes array size mismatch! Must at least get return value and 'this' types!"
                            );
                          var i = ((e) => {
                              for (var t = 1; t < e.length; ++t)
                                if (null !== e[t] && void 0 === e[t].destructorFunction) return !0;
                              return !1;
                            })(t),
                            o = "void" !== t[0].name,
                            _ = a - 2,
                            c = new Array(_),
                            d = [],
                            u = [];
                          return de(e, (...e) => {
                            ((u.length = 0), (d.length = 1), (d[0] = s));
                            for (var n = 0; n < _; ++n)
                              ((c[n] = t[n + 2].toWireType(u, e[n])), d.push(c[n]));
                            return ((e) => {
                              if (i) ue(u);
                              else
                                for (var n = 2; n < t.length; n++)
                                  null !== t[n].destructorFunction &&
                                    t[n].destructorFunction(1 === n ? void 0 : c[n - 2]);
                              if (o) return t[0].fromWireType(e);
                            })(r(...d));
                          });
                        })(e, s, 0, a, i),
                        t - 1
                      ),
                      []
                    );
                  })(s);
                  o.length !== n.length && V("Mismatched type converter count");
                  for (var _ = 0; _ < n.length; ++_) $(n[_], o[_]);
                }
                n.forEach((e) => (J[e] = s));
                var _ = new Array(s.length),
                  c = [],
                  d = 0;
                (s.forEach((e, t) => {
                  X.hasOwnProperty(e)
                    ? (_[t] = X[e])
                    : (c.push(e),
                      Y.hasOwnProperty(e) || (Y[e] = []),
                      Y[e].push(() => {
                        ((_[t] = X[e]), ++d === c.length && o(_));
                      }));
                }),
                  0 === c.length && o(_));
              })([], c));
          },
          h(e, t, n, r, s) {
            t = N(t);
            var a = (e) => e;
            if (0 === r) {
              var i = 32 - 8 * n;
              a = (e) => (e << i) >>> i;
            }
            var o = t.includes("unsigned");
            $(e, {
              name: t,
              fromWireType: a,
              toWireType: o ? (e, t) => t >>> 0 : (e, t) => t,
              argPackAdvance: 8,
              readValueFromPointer: ge(t, n, 0 !== r),
              destructorFunction: null
            });
          },
          b(e, t, n) {
            var r = [
              Int8Array,
              Uint8Array,
              Int16Array,
              Uint16Array,
              Int32Array,
              Uint32Array,
              Float32Array,
              Float64Array
            ][t];
            function s(e) {
              return new r(v.buffer, y[(e + 4) >> 2], y[e >> 2]);
            }
            $(
              e,
              { name: (n = N(n)), fromWireType: s, argPackAdvance: 8, readValueFromPointer: s },
              { ignoreDuplicateRegistrations: !0 }
            );
          },
          q(e, t) {
            $(e, {
              name: (t = N(t)),
              fromWireType(e) {
                for (var t, n = y[e >> 2], r = e + 4, s = r, a = 0; a <= n; ++a) {
                  var i = r + a;
                  if (a == n || 0 == A[i]) {
                    var o = ve(s, i - s);
                    (void 0 === t ? (t = o) : ((t += String.fromCharCode(0)), (t += o)),
                      (s = i + 1));
                  }
                }
                return (Ye(e), t);
              },
              toWireType(e, t) {
                var n;
                t instanceof ArrayBuffer && (t = new Uint8Array(t));
                var r = "string" == typeof t;
                (r ||
                  t instanceof Uint8Array ||
                  t instanceof Uint8ClampedArray ||
                  t instanceof Int8Array ||
                  K("Cannot pass non-string to std::string"),
                  (n = r
                    ? ((e) => {
                        for (var t = 0, n = 0; n < e.length; ++n) {
                          var r = e.charCodeAt(n);
                          r <= 127
                            ? t++
                            : r <= 2047
                              ? (t += 2)
                              : r >= 55296 && r <= 57343
                                ? ((t += 4), ++n)
                                : (t += 3);
                        }
                        return t;
                      })(t)
                    : t.length));
                var s = Ne(4 + n + 1),
                  a = s + 4;
                if (((y[s >> 2] = n), r))
                  ((e, t, n, r) => {
                    if (!(r > 0)) return 0;
                    for (var s = n + r - 1, a = 0; a < e.length; ++a) {
                      var i = e.charCodeAt(a);
                      if (
                        (i >= 55296 &&
                          i <= 57343 &&
                          (i = (65536 + ((1023 & i) << 10)) | (1023 & e.charCodeAt(++a))),
                        i <= 127)
                      ) {
                        if (n >= s) break;
                        t[n++] = i;
                      } else if (i <= 2047) {
                        if (n + 1 >= s) break;
                        ((t[n++] = 192 | (i >> 6)), (t[n++] = 128 | (63 & i)));
                      } else if (i <= 65535) {
                        if (n + 2 >= s) break;
                        ((t[n++] = 224 | (i >> 12)),
                          (t[n++] = 128 | ((i >> 6) & 63)),
                          (t[n++] = 128 | (63 & i)));
                      } else {
                        if (n + 3 >= s) break;
                        ((t[n++] = 240 | (i >> 18)),
                          (t[n++] = 128 | ((i >> 12) & 63)),
                          (t[n++] = 128 | ((i >> 6) & 63)),
                          (t[n++] = 128 | (63 & i)));
                      }
                    }
                    t[n] = 0;
                  })(t, A, a, n + 1);
                else if (r)
                  for (var i = 0; i < n; ++i) {
                    var o = t.charCodeAt(i);
                    (o > 255 &&
                      (Ye(a), K("String has UTF-16 code units that do not fit in 8 bits")),
                      (A[a + i] = o));
                  }
                else for (i = 0; i < n; ++i) A[a + i] = t[i];
                return (null !== e && e.push(Ye, s), s);
              },
              argPackAdvance: 8,
              readValueFromPointer: re,
              destructorFunction(e) {
                Ye(e);
              }
            });
          },
          l(e, t, n) {
            var r, s, a, i;
            ((n = N(n)),
              2 === t
                ? ((r = Ae), (s = be), (i = we), (a = (e) => w[e >> 1]))
                : 4 === t && ((r = xe), (s = ye), (i = Be), (a = (e) => y[e >> 2])),
              $(e, {
                name: n,
                fromWireType(e) {
                  for (var n, s = y[e >> 2], i = e + 4, o = 0; o <= s; ++o) {
                    var _ = e + 4 + o * t;
                    if (o == s || 0 == a(_)) {
                      var c = r(i, _ - i);
                      (void 0 === n ? (n = c) : ((n += String.fromCharCode(0)), (n += c)),
                        (i = _ + t));
                    }
                  }
                  return (Ye(e), n);
                },
                toWireType(e, r) {
                  "string" != typeof r && K(`Cannot pass non-string to C++ string type ${n}`);
                  var a = i(r),
                    o = Ne(4 + a + t);
                  return ((y[o >> 2] = a / t), s(r, o + 4, a + t), null !== e && e.push(Ye, o), o);
                },
                argPackAdvance: 8,
                readValueFromPointer: re,
                destructorFunction(e) {
                  Ye(e);
                }
              }));
          },
          s(e, t) {
            $(e, {
              isVoid: !0,
              name: (t = N(t)),
              argPackAdvance: 0,
              fromWireType() {},
              toWireType(e, t) {}
            });
          },
          B: (e, t, n) => A.copyWithin(e, t, t + n),
          w() {
            ((q = !1), (Pe = 0));
          },
          D: (e, t, n) => ((e = te(e)), (t = ze(t, "emval::as")), Ee(t, n, e)),
          i: (e, t, n, r) => (e = Ce[e])(null, (t = te(t)), n, r),
          k: (e, t, n, r, s) => (e = Ce[e])((t = te(t)), t[(n = Qe(n))], r, s),
          a: ee,
          j: (e) => (0 === e ? ne(ke()) : ((e = Qe(e)), ne(ke()[e]))),
          f(e, t, n) {
            var r = ((e, t) => {
                for (var n = new Array(e), r = 0; r < e; ++r)
                  n[r] = ze(y[(t + 4 * r) >> 2], "parameter " + r);
                return n;
              })(e, t),
              s = r.shift();
            e--;
            var a,
              i,
              o = new Array(e),
              _ = `methodCaller<(${r.map((e) => e.name).join(", ")}) => ${s.name}>`;
            return (
              (a = de(_, (t, a, i, _) => {
                for (var c = 0, d = 0; d < e; ++d)
                  ((o[d] = r[d].readValueFromPointer(_ + c)), (c += r[d].argPackAdvance));
                var u = 1 === n ? Ie(a, o) : a.apply(t, o);
                return Ee(s, i, u);
              })),
              (i = Ce.length),
              Ce.push(a),
              i
            );
          },
          E: (e, t) => ((e = te(e)), (t = te(t)), ne(e[t])),
          n(e) {
            e > 9 && (Z[e + 1] += 1);
          },
          c: (e) => ne(Qe(e)),
          d(e) {
            var t = te(e);
            (ue(t), ee(e));
          },
          e(e, t, n) {
            ((e = te(e)), (t = te(t)), (n = te(n)), (e[t] = n));
          },
          g(e, t) {
            var n = (e = ze(e, "_emval_take_value")).readValueFromPointer(t);
            return ne(n);
          },
          x(e, t) {
            if ((Fe[e] && (clearTimeout(Fe[e].id), delete Fe[e]), !t)) return 0;
            var n = setTimeout(() => {
              (delete Fe[e],
                (() => {
                  if (!E)
                    try {
                      (Xe(e, performance.now()),
                        (() => {
                          if (!je())
                            try {
                              ((p = e = p), Te(e));
                            } catch (e) {
                              Me(e);
                            }
                          var e;
                        })());
                    } catch (e) {
                      Me(e);
                    }
                })());
            }, t);
            return ((Fe[e] = { id: n, timeout_ms: t }), 0);
          },
          y(e) {
            var t = A.length,
              n = 2147483648;
            if ((e >>>= 0) > n) return !1;
            for (var r = 1; r <= 4; r *= 2) {
              var s = t * (1 + 0.2 / r);
              s = Math.min(s, e + 100663296);
              var a = Math.min(n, Le(Math.max(e, s), 65536));
              if (Ue(a)) return !0;
            }
            return !1;
          },
          z: (e) => 52,
          t: (e, t, n, r, s) => 70,
          A(e, t, n, r) {
            for (var s = 0, a = 0; a < n; a++) {
              var i = y[t >> 2],
                o = y[(t + 4) >> 2];
              t += 8;
              for (var _ = 0; _ < o; _++) He(e, A[i + _]);
              s += o;
            }
            return ((y[r >> 2] = s), 0);
          },
          v: Te
        };
      (async () => {
        function e(e, t) {
          return (
            (g = (Oe = e.exports).F),
            C(),
            (se = Oe.K),
            Q.unshift(Oe.G),
            (() => {
              if ((M--, r.monitorRunDependencies?.(M), 0 == M && j)) {
                var e = j;
                ((j = null), e());
              }
            })(),
            Oe
          );
        }
        (M++, r.monitorRunDependencies?.(M));
        var t = { a: Se };
        if (r.instantiateWasm)
          try {
            return r.instantiateWasm(t, e);
          } catch (e) {
            (m(`Module.instantiateWasm callback failed with error: ${e}`), n(e));
          }
        L ??= (() => {
          if (r.locateFile) {
            var e = "avif_dec.wasm";
            return U(e) ? e : ((t = e), r.locateFile ? r.locateFile(t, f) : f + t);
          }
          return new URL("avif_dec.wasm", import.meta.url).href;
        })();
        try {
          var s = await (async (e, t, n) => {
            if (
              !e &&
              "function" == typeof WebAssembly.instantiateStreaming &&
              !U(t) &&
              "function" == typeof fetch
            )
              try {
                var r = fetch(t, { credentials: "same-origin" });
                return await WebAssembly.instantiateStreaming(r, n);
              } catch (e) {
                (m(`wasm streaming compile failed: ${e}`),
                  m("falling back to ArrayBuffer instantiation"));
              }
            return (async (e, t) => {
              try {
                var n = await (async (e) => {
                  if (!z)
                    try {
                      var t = await c(e);
                      return new Uint8Array(t);
                    } catch {}
                  return ((e) => {
                    if (e == L && z) return new Uint8Array(z);
                    if (d) return d(e);
                    throw "both async and sync fetching of the wasm failed";
                  })(e);
                })(e);
                return await WebAssembly.instantiate(n, t);
              } catch (e) {
                (m(`failed to asynchronously prepare wasm: ${e}`), T(e));
              }
            })(t, n);
          })(z, L, t);
          return (
            ((t) => {
              e(t.instance);
            })(s),
            s
          );
        } catch (e) {
          return void n(e);
        }
      })();
      var Re,
        qe = (e) => (qe = Oe.H)(e),
        Ne = (e) => (Ne = Oe.I)(e),
        Ye = (e) => (Ye = Oe.J)(e),
        Xe = (e, t) => (Xe = Oe.L)(e, t);
      function Je() {
        function e() {
          Re ||
            ((Re = !0),
            (r.calledRun = !0),
            E ||
              (R(Q),
              t(r),
              r.onRuntimeInitialized?.(),
              (() => {
                if (r.postRun)
                  for (
                    "function" == typeof r.postRun && (r.postRun = [r.postRun]);
                    r.postRun.length;
                  )
                    F(r.postRun.shift());
                R(k);
              })()));
        }
        M > 0 ||
          ((() => {
            if (r.preRun)
              for ("function" == typeof r.preRun && (r.preRun = [r.preRun]); r.preRun.length;)
                I(r.preRun.shift());
            R(D);
          })(),
          M > 0 ||
            (r.setStatus
              ? (r.setStatus("Running..."),
                setTimeout(() => {
                  (setTimeout(() => r.setStatus(""), 1), e());
                }, 1))
              : e()));
      }
      if (
        ((r.dynCall_iiijii = (e, t, n, s, a, i, o) =>
          (r.dynCall_iiijii = Oe.M)(e, t, n, s, a, i, o)),
        (r.dynCall_jiji = (e, t, n, s, a) => (r.dynCall_jiji = Oe.N)(e, t, n, s, a)),
        (j = function e() {
          (Re || Je(), Re || (j = e));
        }),
        r.preInit)
      )
        for ("function" == typeof r.preInit && (r.preInit = [r.preInit]); r.preInit.length > 0;)
          r.preInit.pop()();
      return (Je(), s);
    });

export { Go as createAvifDecoderModule };
