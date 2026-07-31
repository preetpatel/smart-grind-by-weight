#!/usr/bin/env python3
"""Shaded PNG previews of the CNC enclosure, rendered from the STL
exports with plotly/kaleido (proper depth-buffered rendering).
Cosmetic only — the STEP files are the manufacturing authority.
Run build_enclosure.py first."""

import os

import numpy as np
import plotly.graph_objects as go
from stl import mesh as stlmesh

OUT = os.path.dirname(os.path.abspath(__file__))
os.makedirs(f"{OUT}/previews", exist_ok=True)

ALU = "rgb(186,189,194)"
PC = "rgb(242,241,236)"


def tri_mesh(path, color, translate=(0, 0, 0), flip=False, opacity=1.0):
    m = stlmesh.Mesh.from_file(path)
    v = m.vectors.copy()
    # make winding agree with the STL's stored facet normals, so the
    # renderer's computed normals are consistent everywhere
    calc = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    flipped = np.einsum("ij,ij->i", calc, m.normals) < 0
    v[flipped] = v[flipped][:, ::-1, :]
    if flip:
        v[:, :, 2] = -v[:, :, 2]
        v = v[:, ::-1, :]  # keep winding consistent after mirror
    v = v + np.array(translate)[None, None, :]
    pts = v.reshape(-1, 3)
    n = len(pts) // 3
    idx = np.arange(n * 3).reshape(-1, 3)
    return go.Mesh3d(
        x=pts[:, 0], y=pts[:, 1], z=pts[:, 2],
        i=idx[:, 0], j=idx[:, 1], k=idx[:, 2],
        color=color, opacity=opacity, flatshading=True,
        lighting=dict(ambient=0.72, diffuse=0.42, specular=0.12,
                      roughness=0.6, fresnel=0.05),
        lightposition=dict(x=180, y=-260, z=420),
    )


def render(meshes, out_png, eye, up=(0, 0, 1), zoom=1.0):
    fig = go.Figure(data=meshes)
    fig.update_layout(
        scene=dict(
            xaxis=dict(visible=False), yaxis=dict(visible=False),
            zaxis=dict(visible=False), aspectmode="data",
            camera=dict(eye=dict(x=eye[0] * zoom, y=eye[1] * zoom,
                                 z=eye[2] * zoom),
                        up=dict(x=up[0], y=up[1], z=up[2])),
            bgcolor="white",
        ),
        paper_bgcolor="white",
        margin=dict(l=0, r=0, t=0, b=0),
        width=1400, height=950,
    )
    fig.write_image(out_png, scale=1)
    print("wrote", out_png)


CH = f"{OUT}/stl/verifier-chassis.stl"
PL = f"{OUT}/stl/verifier-top-plate.stl"
IC = f"{OUT}/stl/verifier-icon.stl"
ICON = "rgb(196,195,189)"


def plate_meshes(dz):
    return [tri_mesh(PL, PC, translate=(0, 0, dz)),
            tri_mesh(IC, ICON, translate=(0, 0, dz + 0.06))]


# assembled, iso from front-left (user's approach angle)
render([tri_mesh(CH, ALU)] + plate_meshes(19),
       f"{OUT}/previews/assembly-iso.png", eye=(-1.35, -1.5, 0.95))

# exploded from the rear — USB slot, cavity, NFC posts, rails
render([tri_mesh(CH, ALU)] + plate_meshes(19 + 46),
       f"{OUT}/previews/assembly-exploded.png", eye=(1.15, 1.45, 0.9))

# chassis alone — cavity architecture
render([tri_mesh(CH, ALU)],
       f"{OUT}/previews/chassis-cavity.png", eye=(-0.7, -1.0, 1.5))

# top plate underside — pocket, bosses, register lip, LED window
render([tri_mesh(PL, PC, flip=True)],
       f"{OUT}/previews/top-plate-underside.png", eye=(-0.9, -1.4, 1.9))

# top view — proportions + engraved contactless icon
render([tri_mesh(CH, ALU)] + plate_meshes(19),
       f"{OUT}/previews/assembly-top.png", eye=(0, -0.035, 2.2))
