#!/usr/bin/env python3
"""Re-cut the dosing-cup cradle: resize the base pocket and shift it forward.

    python3 remodel.py [pocket_dia_mm] [forward_shift_mm] [output.stl]
    python3 remodel.py 43.5 8.0 "Cup holder - 43mm base, 8mm forward.stl"

Why a mesh warp instead of CAD: the cradle-to-pedestal transition in the source
STEP is 26 B-spline blend surfaces, so editing the STEP directly would break
tangency, and rebuilding the saddle-shaped backstop from scratch loses fidelity.

Instead the cradle is expanded (or contracted) by a constant *radial* offset
about the cup axis, then translated toward the screw holes.  A constant radial
offset maps every analytic feature of the cradle exactly:

    cylinder  r -> r + dr        cone   r -> r + dr  (at constant z)
    torus     R -> R + dr        planes unchanged

so the 2 mm backstop wall, the 8.74 deg draft angle and the saddle sweep of the
backstop are all preserved rather than approximated.  The deformation is ramped
to zero below the cradle, leaving the mount plate, side rails, screw holes and
every mating face bit-identical to the source.

Requires only numpy.  Reads and writes binary STL.
"""
import struct
import sys

import numpy as np

# ---- source geometry, read out of the STEP ---------------------------------
CUP_X, CUP_Y = 0.0, -115.25          # cup axis in model coordinates
R_POCKET_OLD = 22.6643214217113      # pocket wall at the top of the R2 fillet
R_FLOOR_OLD  = 20.6643214217113      # flat floor radius (= where the fillet starts)
Z_FLOOR      = -156.530              # pocket floor plane
Z_LEDGE      = -154.530              # top of the R2 fillet / ledge plane
R_FILLET     = 2.0

# ---- target ----------------------------------------------------------------
POCKET_DIA_NEW = 43.5                # cup base + clearance
SHIFT_FWD      = 8.0                 # toward the screw holes (-Y)
Z_RAMP_LO      = -167.0              # w = 0 at/below: mount is untouched
Z_RAMP_HI      = -157.0              # w = 1 at/above: full cradle offset
MAX_EDGE       = 1.2                 # blend-band refinement, mm

OUT = 'cupholder-remodelled.stl'
if len(sys.argv) > 1:
    POCKET_DIA_NEW = float(sys.argv[1])
if len(sys.argv) > 2:
    SHIFT_FWD = float(sys.argv[2])
if len(sys.argv) > 3:
    OUT = sys.argv[3]

DR = POCKET_DIA_NEW / 2.0 - R_POCKET_OLD
DY = -SHIFT_FWD


# ---- binary STL io ---------------------------------------------------------
def load_stl(path):
    with open(path, 'rb') as f:
        f.read(80)
        n = struct.unpack('<I', f.read(4))[0]
        b = np.frombuffer(f.read(n * 50), dtype=np.uint8).reshape(n, 50)
    return b[:, 12:48].copy().view('<f4').reshape(n, 3, 3).astype(np.float64)


def write_stl(path, V, F, name=b'smart-grind-by-weight cup holder'):
    tri = V[F]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(n, axis=1)
    ln[ln == 0] = 1
    n = n / ln[:, None]
    buf = np.zeros((len(F), 50), dtype=np.uint8)
    buf[:, 0:12] = n.astype('<f4').view(np.uint8).reshape(-1, 12)
    buf[:, 12:48] = tri.astype('<f4').view(np.uint8).reshape(-1, 36)
    with open(path, 'wb') as f:
        f.write(name.ljust(80, b'\0'))
        f.write(struct.pack('<I', len(F)))
        f.write(buf.tobytes())


# ---- the warp --------------------------------------------------------------
def weight(z):
    return np.clip((z - Z_RAMP_LO) / (Z_RAMP_HI - Z_RAMP_LO), 0.0, 1.0)


def warp(P):
    x = P[:, 0] - CUP_X
    y = P[:, 1] - CUP_Y
    w = weight(P[:, 2])
    dr = DR * w
    rho = np.hypot(x, y)
    # rho >  R_floor : rigid radial offset (exact on cone/torus/cylinder)
    # rho <= R_floor : linear stretch of the flat floor disc (stays planar)
    s_out = (rho + dr) / np.maximum(rho, 1e-12)
    s_in = (R_FLOOR_OLD + dr) / R_FLOOR_OLD
    s = np.where(rho <= R_FLOOR_OLD, s_in, s_out)
    return np.stack([x * s + CUP_X, y * s + CUP_Y + DY * w, P[:, 2]], axis=1)


# ---- mesh plumbing ---------------------------------------------------------
def weld(tris, tol=4):
    """Round only to build the identity key; keep the original float64
    coordinates so untouched geometry stays bit-exact."""
    v = tris.reshape(-1, 3)
    _, first, inv = np.unique(np.round(v, tol), axis=0,
                              return_index=True, return_inverse=True)
    return v[first].astype(np.float64), inv.reshape(-1, 3)


def refine(V, F, split_point):
    """split_point(ia, ib, V) -> point or None.  Decided per *edge*, so the two
    triangles sharing an edge always agree: no cracks, no T-junctions."""
    cuts = {}
    for tri in F:
        for i in range(3):
            a, b = tri[i], tri[(i + 1) % 3]
            k = (a, b) if a < b else (b, a)
            if k in cuts:
                continue
            p = split_point(k[0], k[1], V)
            if p is not None:
                cuts[k] = p
    if not cuts:
        return V, F, 0
    Vl = list(V)
    idx = {}
    for k, p in cuts.items():
        idx[k] = len(Vl)
        Vl.append(p)
    out = []
    for tri in F:
        a, b, c = tri
        e = []
        for u, v_ in ((a, b), (b, c), (c, a)):
            k = (u, v_) if u < v_ else (v_, u)
            e.append(idx.get(k))
        p, q, r = e
        if p is None and q is None and r is None:
            out.append((a, b, c))
        elif q is None and r is None:
            out += [(a, p, c), (p, b, c)]
        elif p is None and r is None:
            out += [(b, q, a), (q, c, a)]
        elif p is None and q is None:
            out += [(c, r, b), (r, a, b)]
        elif r is None:
            out += [(a, p, q), (a, q, c), (p, b, q)]
        elif p is None:
            out += [(b, q, r), (b, r, a), (q, c, r)]
        elif q is None:
            out += [(c, r, p), (c, p, b), (r, a, p)]
        else:
            out += [(a, p, r), (p, b, q), (r, q, c), (p, q, r)]
    return np.array(Vl), np.array(out, dtype=np.int64), len(cuts)


def plane_cutter(zp):
    """Split exactly where an edge crosses z = zp."""
    def f(ia, ib, V):
        za, zb = V[ia, 2], V[ib, 2]
        if (za - zp) * (zb - zp) >= 0:
            return None
        return V[ia] + (V[ib] - V[ia]) * ((zp - za) / (zb - za))
    return f


def length_cutter(maxlen, zlo, zhi):
    """Midpoint-split edges longer than maxlen that lie inside the ramp band."""
    def f(ia, ib, V):
        A, B = V[ia], V[ib]
        # <= zlo: edge is entirely at or below the freeze line, so the warp
        # cannot touch it -> never re-tessellate (keeps the mount byte-identical)
        if max(A[2], B[2]) <= zlo or min(A[2], B[2]) > zhi:
            return None
        if np.linalg.norm(B - A) <= maxlen:
            return None
        return (A + B) * 0.5
    return f


def check(V, F, label):
    E = {}
    for tri in F:
        for i in range(3):
            a, b = tri[i], tri[(i + 1) % 3]
            k = (min(a, b), max(a, b))
            E[k] = E.get(k, 0) + 1
    bad = sum(1 for c in E.values() if c != 2)
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    area = 0.5 * np.linalg.norm(n, axis=1)
    vol = np.einsum('ij,ij->i', V[F[:, 0]],
                    np.cross(V[F[:, 1]], V[F[:, 2]])).sum() / 6.0
    print(f"  {label}: {len(F)} tris, {len(V)} verts, "
          f"non-manifold edges={bad}, degenerate={int((area < 1e-9).sum())}, "
          f"volume={abs(vol) / 1000:.3f} cm^3")
    return bad


def seat_height(r_floor, r_base):
    """Where a flat cup base of radius r_base lands on the R2 fillet ring,
    in mm above the pocket floor."""
    s = (r_base - r_floor) / R_FILLET
    if s >= 1:
        return Z_LEDGE - Z_FLOOR
    if s <= 0:
        return 0.0
    return (Z_LEDGE - R_FILLET * np.sqrt(1 - s * s)) - Z_FLOOR


if __name__ == '__main__':
    tris = load_stl('source/Cup holder (baseline export).stl')
    V, F = weld(tris)
    print("source")
    check(V, F, "loaded")

    for zp in (Z_RAMP_LO, Z_RAMP_HI):
        V, F, n = refine(V, F, plane_cutter(zp))
        print(f"  cut at z={zp}: {n} edges split")
    for it in range(10):
        V, F, n = refine(V, F, length_cutter(MAX_EDGE, Z_RAMP_LO, Z_RAMP_HI + 1.0))
        if n == 0:
            break
    print(f"  refined blend band ({it + 1} passes)")
    check(V, F, "refined")

    frozen = V[:, 2] <= Z_RAMP_LO + 1e-9
    V2 = warp(V)
    moved = np.linalg.norm(V2 - V, axis=1)
    assert moved[frozen].max() < 1e-12, "mount region moved!"
    print(f"  frozen verts (z<={Z_RAMP_LO}): {frozen.sum()}  "
          f"max motion {moved[frozen].max():.2e} mm")

    print("result")
    check(V2, F, "warped")
    write_stl(OUT, V2, F)

    r_floor_new = R_FLOOR_OLD + DR
    r_base = POCKET_DIA_NEW / 2.0 - 0.25
    print(f"\nwrote {OUT}")
    print(f"  pocket dia   {2 * R_POCKET_OLD:.2f} -> {POCKET_DIA_NEW:.2f} mm "
          f"(floor {2 * R_FLOOR_OLD:.2f} -> {2 * r_floor_new:.2f})")
    print(f"  radial offset {DR:+.4f} mm      forward shift {SHIFT_FWD} mm "
          f"(cup axis y {CUP_Y:.2f} -> {CUP_Y + DY:.2f})")
    print(f"  a flat dia-{2 * r_base:.1f} base seats "
          f"{seat_height(r_floor_new, r_base):.2f} mm above the floor")
    b0, b1 = V.min(0), V.max(0)
    c0, c1 = V2.min(0), V2.max(0)
    for i, ax in enumerate('XYZ'):
        print(f"  bbox {ax}: [{b0[i]:8.2f},{b1[i]:8.2f}] -> "
              f"[{c0[i]:8.2f},{c1[i]:8.2f}]")
