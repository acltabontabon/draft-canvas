"""
Renders the story film: one continuous move through the hero's whiteboard diagram, a stop for each
chapter of the page. The page scrubs it with the scroll position (src/storyFilm.js), so nothing
here depends on wall-clock time, only on where in the film a frame is.

It starts from the scene in hero-depth.py, head-on, so the film's first frame is the diagram the
people in the hero drawing are looking at. CHAPTERS below are the film's seconds for each stop;
src/storyFilm.js carries the same numbers. The output is committed. To re-render:

    blender -b -P www/scripts/story-film.py -- /tmp/story-film-frames
    ffmpeg -y -framerate 24 -i /tmp/story-film-frames/%04d.png -an -vf gblur=sigma=0.5 \
      -c:v libx264 -profile:v high -crf 24 -preset slow -g 6 -pix_fmt yuv420p \
      -movflags +faststart www/public/clips/story-film.mp4

A keyframe every six frames keeps scrubbing responsive in every browser.
"""

import importlib.util
import math
import os
import random
import sys

import bpy
from mathutils import Matrix, Vector

spec = importlib.util.spec_from_file_location('hero', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hero-depth.py'))
hero = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hero)

OUT, ONLY = hero.OUT, hero.ONLY
FPS = 24
CHAPTERS = {'dive': (0, 2), 'present': (2, 6), 'nodi': (6, 10.5), 'inside': (10.5, 15), 'evidence': (15, 19), 'collaboration': (19, 23.5), 'points': (23.5, 27.5), 'ending': (27.5, 30)}
SECONDS = 30
LINE = hero.LINE
scene = hero.scene
scene.render.resolution_x = 1024
scene.render.resolution_y = 960
random.seed(11)

BRIGHT = hero.material('bright', (1, 1, 1))


def stroke(name, polylines, parent=None, mat=None, radius=LINE, rough=True):
    return hero.stroke(name, polylines, parent, mat, radius, rough)


def V(x, y, z=0.0):
    return Vector((x, y, z))


def dashed(points, on=2, off=2):
    points = hero.resample(points)
    return [points[i:i + on + 1] for i in range(0, len(points) - on, on + off)]


def rect(w, h, z=0.0):
    c = [V(-w / 2, h / 2, z), V(w / 2, h / 2, z), V(w / 2, -h / 2, z), V(-w / 2, -h / 2, z)]
    return c + [c[0]]


def card(name, location, w, h, depth=.14, parent=None, dash=False):
    """A card lying parallel to the board: outline, thickness and an unlit body."""
    pivot = hero.empty(name, location)
    pivot.parent = parent
    front = rect(w, h)
    stroke(name + '-front', dashed(front) if dash else [front], pivot)
    if not dash:
        back = rect(w, h, -depth)
        stroke(name + '-back', [back] + [[a, b] for a, b in zip(front[:4], back[:4])], pivot, rough=False, radius=LINE * .8)
        hero.void_box(name + '-body', w, h, depth, pivot)
    return pivot


def crate(name, parent, centre, w, d, h):
    """A box standing on the board (z is up): twelve edges and an unlit body."""
    x, y, z = centre
    low = [V(x - w / 2, y - d / 2, z - h / 2), V(x + w / 2, y - d / 2, z - h / 2), V(x + w / 2, y + d / 2, z - h / 2), V(x - w / 2, y + d / 2, z - h / 2)]
    high = [p + V(0, 0, h) for p in low]
    stroke(name, [low + [low[0]], high + [high[0]]] + [[a, b] for a, b in zip(low, high)], parent, rough=False)
    bpy.ops.mesh.primitive_cube_add(size=1)
    body = bpy.context.active_object
    body.scale = (w - .02, d - .02, h - .02)
    body.location = centre
    body.data.materials.append(hero.VOID_MAT)
    body.parent = parent


def label(text, parent, location, size):
    bpy.ops.object.text_add()
    obj = bpy.context.active_object
    obj.data.body = text
    obj.data.size = size
    obj.data.align_x = 'CENTER'
    obj.data.align_y = 'CENTER'
    obj.data.materials.append(hero.INK_MAT)
    obj.rotation_euler = (math.pi / 2, 0, 0)
    obj.location = location
    obj.parent = parent
    return obj


def pin(name, location, text):
    """A marker standing on the board: a stalk, a ring, and what it says."""
    pivot = hero.empty(name, location)
    ring = [V(.19 * math.cos(a), 0, .7 + .19 * math.sin(a)) for a in [math.tau * k / 40 for k in range(41)]]
    stroke(name + '-ink', [[V(0, 0, 0), V(0, 0, .51)], ring], pivot, rough=False)
    label(text, pivot, (0, 0, .7), .24)
    return pivot


def growing(name, points, parent=None, mat=None, radius=LINE):
    """A single stroke that can be drawn in along its length."""
    obj = stroke(name, [points], parent, mat, radius)
    obj.data.bevel_factor_mapping_end = 'SPLINE'
    return obj


POPS = []  # (object, appears at, optional leaves at, optional comes back at)
DRAWS = []  # (curve object, starts, seconds)


def pops(obj, at, until=None, back=None):
    POPS.append((obj, at, until, back))
    return obj


def draws(obj, at, seconds=.7):
    DRAWS.append((obj, at, seconds))
    return obj


def place(obj):
    return obj.matrix_world.translation.copy() if obj.parent else obj.location.copy()


bpy.context.view_layer.update()
A, B, D, E = [c[0].location.copy() for c in hero.cards]
SERVICE = hero.service.location.copy()
STORE = hero.store.location.copy()

# 1 · Walk through: a request crosses the system, and each step it reaches is numbered.
# The numbers belong to this walk: they fold away as the camera moves on.
steps = [pops(pin('step-1', A, '1'), 2.7, 6.5), pops(pin('step-2', SERVICE + V(.5, .22, 0), '2'), 4.0, 6.6), pops(pin('step-3', STORE + V(0, .2, .35), '3'), 5.3, 6.7)]
bpy.ops.mesh.primitive_uv_sphere_add(radius=.075, segments=20, ring_count=10)
request = bpy.context.active_object
request.data.materials.append(BRIGHT)
ROUTE = [(2.7, 4.0, hero.wires[0]), (4.0, 5.3, hero.wires[4])]

# 2 · Ask Nodi: the agent steps up, proposes a card in dashes, and it is accepted into ink.
nodi = pops(hero.empty('nodi', B + V(2.0, -.75, -B.z)), 7.3)
crate('nodi-head', nodi, (0, 0, .98), 1.0, .5, .7)
crate('nodi-body', nodi, (0, 0, .4), .5, .34, .34)
crate('nodi-foot-l', nodi, (-.14, 0, .1), .14, .2, .14)
crate('nodi-foot-r', nodi, (.14, 0, .1), .14, .2, .14)
front = -.262
stroke('nodi-face', [
    [V(-.36, front, 1.2), V(.36, front, 1.2), V(.36, front, .78), V(-.36, front, .78), V(-.36, front, 1.2)],
    [V(-.2, front, 1.08), V(-.2, front, .98)], [V(.2, front, 1.08), V(.2, front, .98)],
    [V(-.1, front, .88), V(.1, front, .88)],
    [V(0, 0, 1.33), V(0, 0, 1.52)], [V(-.07, 0, 1.52), V(.07, 0, 1.52)],
    [V(-.25, 0, .5), V(-.62, 0, .78)],
], nodi, rough=False, radius=LINE * 1.15)
PROPOSED = B + V(1.75, .95, -.1)
proposal = pops(card('proposed', PROPOSED, .95, .56, dash=True), 8.3, 9.6)
proposal_wire = pops(stroke('proposed-wire', dashed([B + V(.42, .1, 0), V(PROPOSED.x, B.y + .1, PROPOSED.z), PROPOSED + V(0, -.28, 0)])), 8.6, 9.6)
accepted = pops(card('accepted', PROPOSED, .95, .56), 9.6)
accepted_wire = draws(growing('accepted-wire', [B + V(.42, .1, 0), V(PROPOSED.x, B.y + .1, PROPOSED.z), PROPOSED + V(0, -.28, 0)]), 9.6, .6)
tick = draws(growing('accepted-tick', [PROPOSED + V(-.2, 0, .02), PROPOSED + V(-.06, -.14, .02), PROPOSED + V(.24, .16, .02)], radius=LINE * 1.3, mat=BRIGHT), 9.9, .4)

# 3 · Look inside: under the open service is a room of its own, tied to it by four threads.
ROOM = SERVICE + V(0, -.1, -3.4)
BELOW = 19.5  # when the camera leaves the lower level, and it folds away
BURIED = []  # strokes of the lower level, hidden once it has
room = pops(hero.empty('room', ROOM), 11.5, BELOW)
outline = hero.parse('M-110 -62Q-110 -74 -98 -74L98 -74Q110 -74 110 -62L110 62Q110 74 98 74L-98 74Q-110 74 -110 62Z')[0]
stroke('room-sheet', [[V(x / 100, -y / 100, 0) for x, y in outline]], room)
parts = [
    pops(card('part-a', ROOM + V(-.5, .28, .16), .62, .36, .1), 11.9, BELOW),
    pops(card('part-b', ROOM + V(.45, .28, .22), .62, .36, .1), 12.1, BELOW),
    pops(card('part-c', ROOM + V(-.05, -.34, .3), .74, .36, .1), 12.3, BELOW),
]
part_wires = [
    draws(growing('part-ab', [ROOM + V(-.19, .28, .16), ROOM + V(.14, .28, .22)]), 12.6, .4),
    draws(growing('part-ac', [ROOM + V(-.5, .1, .16), ROOM + V(-.5, -.34, .25), ROOM + V(-.42, -.34, .3)]), 12.8, .5),
    draws(growing('part-bc', [ROOM + V(.45, .1, .22), ROOM + V(.45, -.34, .27), ROOM + V(.32, -.34, .3)]), 13.0, .5),
]
corners = [(-.745, .395), (.745, .395), (.745, -.395), (-.745, -.395)]
room_corners = [(-1.1, .74), (1.1, .74), (1.1, -.74), (-1.1, -.74)]
threads = pops(stroke('room-threads', [d for (sx, sy), (rx, ry) in zip(corners, room_corners)
                                        for d in dashed([SERVICE + V(sx * .95, sy * .95, -.22), ROOM + V(rx, ry, 0)], 2, 3)],
                      mat=hero.FAINT_MAT, radius=LINE * .8, rough=False), 11.5)
BURIED += [threads, *part_wires]

# 4 · From your code: the source the picture was read from, and what in it backs each part.
CODE = ROOM + V(-2.9, -.05, 0)
sheets = [pops(card(f'file-{i}', CODE + V(.13 * i, -.09 * i, .26 * i), .95, 1.25, .03), 15.5 + .3 * i, BELOW) for i in range(3)]
top = CODE + V(.26, -.18, .52)
lines = [(0, .5), (.08, .62), (.08, .4), (.16, .5), (.08, .3), (0, .56), (.08, .44), (0, .2)]
code_lines = pops(stroke('code-lines', [[top + V(-.36 + indent, .47 - .13 * row, .01), top + V(-.36 + indent + length, .47 - .13 * row, .01)]
                                        for row, (indent, length) in enumerate(lines)], mat=hero.FAINT_MAT, radius=LINE * .9, rough=False), 16.4)
evidence = []
for index, (row, part, at) in enumerate([(1, 0, 17.0), (5, 2, 17.9)]):
    indent, length = lines[row]
    a, b = top + V(-.36 + indent, .47 - .13 * row, .02), top + V(-.36 + indent + length, .47 - .13 * row, .02)
    evidence.append(draws(growing(f'proof-{index}', [a, b], radius=LINE * 1.5, mat=BRIGHT), at, .35))
    target = place(parts[part]) + V(-.3, 0, .02)
    BURIED += evidence[-1:]
    evidence.append(draws(growing(f'proof-thread-{index}', [b + V(.04, 0, 0), b + V(.3, 0, .25), target + V(-.25, 0, .2), target]), at + .3, .6))

BURIED += [code_lines, *evidence]

# 5 · Together: three people on one canvas; one of them adds a card while the others look on.
ARROW = [V(0, 0), V(0, -.44), V(.11, -.33), V(.2, -.54), V(.28, -.5), V(.19, -.3), V(.33, -.3), V(0, 0)]
NEW = V(-2.55, -.3, .5)
cursors = []
for index, home in enumerate([V(.5, .75, 1.5), NEW + V(.2, .1, .55), V(-1.1, -1.35, 1.6)]):
    cursor = pops(hero.empty(f'cursor-{index}', home), 20.0 + .3 * index, 24.0 + .15 * index)
    cursor['size'] = 1.5
    stroke(f'cursor-{index}-ink', [ARROW, [p + V(.34, -.78, 0) for p in rect(.52, .2)], [V(.2, -.78, 0), V(.2 + .12 * (index + 1), -.78, 0)]], cursor, rough=False)
    cursors.append((cursor, home))
new_card = pops(card('new-card', NEW, .78, .46), 21.3)
new_wire = draws(growing('new-wire', [NEW + V(.39, 0, 0), V(-1.85, NEW.y, .4), V(-1.85, SERVICE.y, .25), SERVICE + V(-.72, 0, 0)]), 22.1, .8)

# 6 · Open questions: what is still unsettled stays pinned to the part it concerns.
questions = [pops(pin('question-1', E, '?'), 24.5), pops(pin('question-2', new_card.location + V(.1, 0, 0), '?'), 25.3), pops(pin('question-3', STORE + V(0, .2, .35), '?'), 26.1)]

# The camera: where it looks, how far round and how steeply, and from how far.
camera_data = bpy.data.cameras.new('film')
camera_data.lens = 50
camera_data.clip_start = .05
camera = bpy.data.objects.new('film', camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
MOVES = [
    (0, (0, 0, 0), 0, 0, 10.4),
    (2, (-.9, .3, .3), 26, 44, 8.2),
    (4, (-.5, .1, .4), 14, 52, 7.0),
    (6, (.4, -.5, .6), 2, 50, 6.6),
    (7.4, (B.x + 1.1, B.y, .6), -20, 50, 6.4),
    (10.5, (B.x + 1.3, B.y + .1, .7), -30, 52, 6.0),
    (11.8, (SERVICE.x, SERVICE.y, .2), -4, 12, 5.4),
    # Straight down through the middle of the open service, clear of its outline.
    (12.8, (SERVICE.x, SERVICE.y, -1.3), 0, 1, 2.2),
    (13.7, (SERVICE.x, SERVICE.y - .03, ROOM.z + .1), 0, 3, 2.9),
    (15, (ROOM.x, ROOM.y, ROOM.z + .15), -16, 42, 3.7),
    (16.4, (CODE.x + .7, CODE.y, CODE.z + .3), 14, 42, 4.0),
    (19, (CODE.x + .9, CODE.y, CODE.z + .3), 24, 44, 3.9),
    (20.9, (-.9, -.1, .6), -24, 46, 7.4),
    (23.5, (-1.1, -.2, .6), -14, 50, 7.0),
    (24.7, (-.5, -.7, .9), 12, 58, 6.8),
    (27.5, (-.3, -.6, .9), 20, 56, 6.6),
    (30, (0, 0, 0), 0, 0, 11.6),
]


def smooth(u):
    return u * u * u * (u * (u * 6 - 15) + 10)


def mix(a, b, u):
    return a + (b - a) * u


def look(t):
    for (t0, p0, yaw0, tilt0, d0), (t1, p1, yaw1, tilt1, d1) in zip(MOVES, MOVES[1:]):
        if t <= t1:
            u = smooth((t - t0) / (t1 - t0))
            target = Vector(p0).lerp(Vector(p1), u)
            yaw, tilt, distance = math.radians(mix(yaw0, yaw1, u)), math.radians(mix(tilt0, tilt1, u)), mix(d0, d1, u)
            break
    offset = Matrix.Rotation(yaw, 3, 'Z') @ Vector((0, -math.sin(tilt), math.cos(tilt))) * distance
    camera.location = target + offset
    # A turntable: the far side of the board is always up, also when looking straight down at it.
    back = offset.normalized()
    up = Matrix.Rotation(yaw, 3, 'Z') @ Vector((0, math.cos(tilt), math.sin(tilt)))
    right = up.cross(back)
    camera.rotation_euler = Matrix((right, up, back)).transposed().to_euler()


def pop(t, at):
    """Nothing, then there with a small overshoot, the way a pencil lands."""
    u = (t - at) / .45
    if u <= 0:
        return 0.0
    if u >= 1:
        return 1.0
    return 1 + 2.2 * (u - 1) ** 3 + 1.2 * (u - 1) ** 2


def pose(frame):
    t = frame / FPS
    hero.pose(frame % hero.FRAMES)
    hero.rig.rotation_euler = (0, 0, 0)
    look(t)
    for obj, at, until, back in POPS:
        size = pop(t, at) * (1 - pop(t, until) if until is not None else 1) + (pop(t, back) if back is not None else 0)
        size *= obj.get('size', 1)
        obj.scale = (size, size, size)
    for obj, at, seconds in DRAWS:
        obj.data.bevel_factor_end = max(0.0, min(1.0, (t - at) / seconds))
        obj.hide_render = t <= at
    for obj in BURIED:
        obj.hide_render = obj.hide_render or t > BELOW
    # The small components inside the service step aside while the camera passes through to the room.
    gone = 1 - pop(t, 11.4) * (1 - pop(t, 28.2))
    hero.inside.scale = (gone * hero.near(-.75),) * 3
    request.scale = (0, 0, 0)
    for start, end, wire in ROUTE:
        if start <= t < end:
            along = smooth((t - start) / (end - start))
            position = along * (len(wire) - 1)
            index = min(int(position), len(wire) - 2)
            request.location = wire[index].lerp(wire[index + 1], position - index)
            request.scale = (1, 1, 1)
    hop = max(0.0, 1 - abs(t - 9.75) / .3)
    nodi.location.z = .12 * math.sin(math.pi * hop)
    for index, (cursor, home) in enumerate(cursors):
        s = (t - 19.6) * (.9 + .2 * index) + index * 2.1
        cursor.location = home + V(.5 * math.sin(s), .32 * math.sin(1.7 * s + index), 0) * (0.25 if index == 1 else 1)


if __name__ == '__main__':
    for frame in (ONLY or range(SECONDS * FPS + 1)):
        pose(frame)
        scene.frame_set(frame)
        scene.render.filepath = f'{OUT}/{frame:04d}.png'
        bpy.ops.render.render(write_still=True)
