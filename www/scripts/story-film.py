"""
Renders the story film: one continuous move through an architecture diagram drawn in chalk, a stop
for each chapter of the page. The page scrubs it with the scroll position (src/storyFilm.js), so
nothing here depends on wall-clock time, only on where in the film a frame is.

The film opens with INTRO seconds in which the diagram is drawn; the page plays those on arrival.
After that, CHAPTERS are the film's seconds for each stop, counted from the end of the opening;
src/storyFilm.js carries the same numbers. The base diagram is the scene in hero-depth.py. The
page draws the film from its frames, so after rendering they are packed, not encoded as video:

    blender -b -P www/scripts/story-film.py -- /tmp/story-film-frames
    node www/scripts/pack-film.mjs /tmp/story-film-frames

The packed files are committed, so the site builds without Blender.
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
INTRO = 2  # seconds before the story's zero in which the diagram is drawn; the page plays these on arrival
LINE = hero.LINE
scene = hero.scene
scene.render.resolution_x = 1920
scene.render.resolution_y = 1080
random.seed(11)

BRIGHT = hero.material('bright', (1, 1, 1))
# Three chalks: white for the drawing, the brand's mint for what is live or the agent's, and a warm
# yellow for what is still open.
MINT = hero.material('mint', (0.37, 0.84, 0.79))
WARM = hero.material('warm', (0.95, 0.82, 0.55))


def fading(name, colour):
    """A material whose ink can be faded out, for the level below the board."""
    mat = hero.material(name, colour)
    FADING.append(mat.node_tree.nodes['Emission'].inputs['Strength'])
    return mat


FADING = []
LOW_INK = fading('low-ink', hero.INK)
LOW_FAINT = fading('low-faint', tuple(c * .5 for c in hero.INK))
LOW_MINT = fading('low-mint', (0.37, 0.84, 0.79))
HAND = '/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf'
FONT = bpy.data.fonts.load(HAND) if os.path.exists(HAND) else None


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


def card(name, location, w, h, depth=.14, parent=None, dash=False, mat=None):
    """A card lying parallel to the board: outline, thickness and an unlit body."""
    pivot = hero.empty(name, location)
    pivot.parent = parent
    front = rect(w, h)
    stroke(name + '-front', dashed(front) if dash else [front], pivot, mat)
    if not dash:
        back = rect(w, h, -depth)
        stroke(name + '-back', [back] + [[a, b] for a, b in zip(front[:4], back[:4])], pivot, mat, rough=False, radius=LINE * .8)
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


def label(text, parent, location, size, mat=None, flat=False, align='CENTER'):
    """Handwriting: standing up to face the camera, or lying flat on a card."""
    bpy.ops.object.text_add()
    obj = bpy.context.active_object
    obj.data.body = text
    obj.data.size = size
    obj.data.align_x = align
    obj.data.align_y = 'CENTER'
    if FONT:
        obj.data.font = FONT
    obj.data.materials.append(mat or hero.INK_MAT)
    obj.rotation_euler = (0, 0, 0) if flat else (math.pi / 2, 0, 0)
    obj.location = location
    obj.parent = parent
    return obj


def pin(name, location, text, mat=None, says=None):
    """A marker standing on the board: a stalk, a ring, and what it says."""
    pivot = hero.empty(name, location)
    ring = [V(.19 * math.cos(a), 0, .7 + .19 * math.sin(a)) for a in [math.tau * k / 40 for k in range(41)]]
    stroke(name + '-ink', [[V(0, 0, 0), V(0, 0, .51)], ring], pivot, mat, rough=False)
    label(text, pivot, (0, 0, .7), .3, mat)
    if says:
        label(says, pivot, (.27, 0, .7), .25, mat, align='LEFT')
    return pivot


def growing(name, points, parent=None, mat=None, radius=LINE, rough=True):
    """A single stroke that can be drawn in along its length."""
    obj = stroke(name, [points], parent, mat, radius, rough)
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


def named(parent, text, at, size=.17, mat=None, offset=(0, 0)):
    """What a card is, written on it."""
    return pops(label(text, parent, (offset[0], offset[1], .012), size, mat, flat=True), at)


def place(obj):
    return obj.matrix_world.translation.copy() if obj.parent else obj.location.copy()


bpy.context.view_layer.update()
A, B, D, E = [c[0].location.copy() for c in hero.cards]
SERVICE = hero.service.location.copy()
STORE = hero.store.location.copy()

for index, (pivot, _, _) in enumerate(hero.cards):
    named(pivot, ['Web', 'Orders', 'Email', 'Queue'][index], -1.0 + .12 * index, [.21, .24, .19, .23][index])
pops(label('Checkout', None, SERVICE + V(.3, -.6, 0), .22, flat=True), -.5)
pops(label('Orders DB', None, STORE + V(0, -.7, -.25), .22, flat=True), -.4)

# The opening: the diagram is drawn before the story starts. Cards land, then their connectors.
for index, (pivot, _, _) in enumerate(hero.cards):
    pops(pivot, -1.9 + .12 * index)
pops(hero.service, -1.55)
hero.store['size'] = hero.near(.75)
pops(hero.store, -1.4)
BASE_WIRES = [obj for obj in bpy.data.objects if obj.name.startswith('wire-')]
for index, wire in enumerate(BASE_WIRES):
    wire.data.bevel_factor_mapping_end = 'SPLINE'
    draws(wire, -1.3 + .08 * index, .55)

# 1 · Walk through: a request crosses the system, and each step it reaches is numbered.
# The numbers belong to this walk: they fold away as the camera moves on.
steps = [pops(pin('step-1', A, '1', says='order placed'), 2.7, 6.5), pops(pin('step-2', SERVICE + V(.5, .22, 0), '2', says='checked out'), 4.0, 6.6), pops(pin('step-3', STORE + V(0, .2, .35), '3', says='saved'), 5.3, 6.7)]
bpy.ops.mesh.primitive_uv_sphere_add(radius=.075, segments=20, ring_count=10)
request = bpy.context.active_object
request.data.materials.append(MINT)
ROUTE = [(2.7, 4.0, hero.wires[0]), (4.0, 5.3, hero.wires[4])]
# The way it came stays lit behind it, until the walk is over.
TRAILS = [draws(growing(f'trail-{index}', wire, mat=MINT, radius=LINE * 1.5, rough=False), start, end - start) for index, (start, end, wire) in enumerate(ROUTE)]

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
], nodi, MINT, rough=False, radius=LINE * 1.3)
stroke('nodi-limbs', [[V(0, 0, 1.33), V(0, 0, 1.52)], [V(-.07, 0, 1.52), V(.07, 0, 1.52)], [V(-.25, 0, .5), V(-.62, 0, .78)]], nodi, rough=False, radius=LINE * 1.15)
# It thinks before it proposes: three dots in a bubble, one after another.
bubble = pops(hero.empty('bubble', B + V(2.0, -.75, -B.z) + V(-.75, 0, 1.75)), 7.7, 9.5)
stroke('bubble-ink', [[V(.46 * math.cos(a), 0, .27 * math.sin(a)) for a in [math.tau * k / 48 for k in range(49)]], [V(.2, 0, -.24), V(.42, 0, -.42), V(.34, 0, -.2)]], bubble, rough=False)
for index in range(3):
    dot = pops(hero.empty(f'thought-{index}', bubble.location + V(-.2 + .2 * index, 0, 0)), 7.95 + .22 * index, 9.5)
    stroke(f'thought-{index}-ink', [[V(.035 * math.cos(a), 0, .035 * math.sin(a)) for a in [math.tau * k / 12 for k in range(13)]]], dot, MINT, LINE * 1.6, rough=False)
PROPOSED = B + V(1.75, .95, -.1)
proposal = pops(card('proposed', PROPOSED, .95, .56, dash=True, mat=MINT), 8.6, 9.6)
label('Cache?', proposal, (0, 0, .012), .24, MINT, flat=True)
proposal_wire = pops(stroke('proposed-wire', dashed([B + V(.42, .1, 0), V(PROPOSED.x, B.y + .1, PROPOSED.z), PROPOSED + V(0, -.28, 0)]), mat=MINT), 8.9, 9.6)
accepted = pops(card('accepted', PROPOSED, .95, .56), 9.6)
named(accepted, 'Cache', 9.7, .25)
accepted_wire = draws(growing('accepted-wire', [B + V(.42, .1, 0), V(PROPOSED.x, B.y + .1, PROPOSED.z), PROPOSED + V(0, -.28, 0)]), 9.6, .6)
tick = draws(growing('accepted-tick', [PROPOSED + V(.2, .42, .02), PROPOSED + V(.32, .3, .02), PROPOSED + V(.58, .58, .02)], radius=LINE * 1.5, mat=MINT), 9.9, .4)

# 3 · Look inside: under the open service is a room of its own, tied to it by four threads.
ROOM = SERVICE + V(0, -.1, -3.4)
BELOW = 19.3  # when the camera leaves the lower level, and its ink fades out
BURIED = []  # everything on the lower level, hidden once it has faded
room = pops(hero.empty('room', ROOM), 11.5)
outline = hero.parse('M-110 -62Q-110 -74 -98 -74L98 -74Q110 -74 110 -62L110 62Q110 74 98 74L-98 74Q-110 74 -110 62Z')[0]
label('inside Checkout', room, (-1.05, .86, 0), .15, LOW_INK, flat=True, align='LEFT')
stroke('room-sheet', [[V(x / 100, -y / 100, 0) for x, y in outline]], room, LOW_INK)
parts = [
    pops(card('part-a', ROOM + V(-.5, .28, .16), .62, .36, .1, mat=LOW_INK), 11.9),
    pops(card('part-b', ROOM + V(.45, .28, .22), .62, .36, .1, mat=LOW_INK), 12.1),
    pops(card('part-c', ROOM + V(-.05, -.34, .3), .74, .36, .1, mat=LOW_INK), 12.3),
]
for index, part in enumerate(parts):
    BURIED.append(named(part, ['API', 'Rules', 'Store'][index], 12.4 + .1 * index, .15, LOW_INK))
part_wires = [
    draws(growing('part-ab', [ROOM + V(-.19, .28, .16), ROOM + V(.14, .28, .22)], mat=LOW_INK), 12.6, .4),
    draws(growing('part-ac', [ROOM + V(-.5, .1, .16), ROOM + V(-.5, -.34, .25), ROOM + V(-.42, -.34, .3)], mat=LOW_INK), 12.8, .5),
    draws(growing('part-bc', [ROOM + V(.45, .1, .22), ROOM + V(.45, -.34, .27), ROOM + V(.32, -.34, .3)], mat=LOW_INK), 13.0, .5),
]
corners = [(-.745, .395), (.745, .395), (.745, -.395), (-.745, -.395)]
room_corners = [(-1.1, .74), (1.1, .74), (1.1, -.74), (-1.1, -.74)]
threads = pops(stroke('room-threads', [d for (sx, sy), (rx, ry) in zip(corners, room_corners)
                                        for d in dashed([SERVICE + V(sx * .95, sy * .95, -.22), ROOM + V(rx, ry, 0)], 2, 3)],
                      mat=LOW_FAINT, radius=LINE * .8, rough=False), 11.5)
BURIED += [room, *parts, threads, *part_wires]

# 4 · From your code: the source the picture was read from, and what in it backs each part.
CODE = ROOM + V(-2.9, -.05, 0)
sheets = [pops(card(f'file-{i}', CODE + V(.13 * i, -.09 * i, .26 * i), .95, 1.25, .03, mat=LOW_INK), 15.5 + .3 * i) for i in range(3)]
top = CODE + V(.26, -.18, .52)
lines = [(0, .5), (.08, .62), (.08, .4), (.16, .5), (.08, .3), (0, .56), (.08, .44), (0, .2)]
code_lines = pops(stroke('code-lines', [[top + V(-.36 + indent, .47 - .13 * row, .01), top + V(-.36 + indent + length, .47 - .13 * row, .01)]
                                        for row, (indent, length) in enumerate(lines)], mat=LOW_FAINT, radius=LINE * .9, rough=False), 16.4)
BURIED.append(pops(label('checkout.ts', None, top + V(-.42, .74, .01), .15, LOW_INK, flat=True, align='LEFT'), 16.2))
evidence = []
for index, (row, part, at) in enumerate([(1, 0, 17.0), (5, 2, 17.9)]):
    indent, length = lines[row]
    a, b = top + V(-.36 + indent, .47 - .13 * row, .02), top + V(-.36 + indent + length, .47 - .13 * row, .02)
    evidence.append(draws(growing(f'proof-{index}', [a, b], radius=LINE * 1.6, mat=LOW_MINT), at, .35))
    target = place(parts[part]) + V(-.3, 0, .02)
    evidence.append(draws(growing(f'proof-thread-{index}', [b + V(.04, 0, 0), b + V(.3, 0, .25), target + V(-.25, 0, .2), target], mat=LOW_MINT), at + .3, .6))

BURIED += [*sheets, code_lines, *evidence]

# 5 · Together: three people join at the board, each in a chalk of their own with their name over
# their head, and each with a pointer in the same colour; one of them adds a card while the others look on.
ARROW = [V(0, 0), V(0, -.44), V(.11, -.33), V(.2, -.54), V(.28, -.5), V(.19, -.3), V(.33, -.3), V(0, 0)]
NEW = V(-2.55, -.3, .5)
FIGURE = [V(x / 100, 0, z / 100) for x, z in hero.parse('M-34 0Q-33 40 -18 55Q-10 62 0 62Q10 62 18 55Q33 40 34 0')[0]]
HEAD = [V(.2 * math.cos(a), 0, .86 + .2 * math.sin(a)) for a in [math.tau * k / 32 for k in range(33)]]


def filled(name, outline, parent):
    """An unlit shape just behind an outline, so a figure hides what it stands in front of."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([p + V(0, .015, 0) for p in outline], [], [list(range(len(outline)))])
    obj = bpy.data.objects.new(name, mesh)
    obj.data.materials.append(hero.VOID_MAT)
    scene.collection.objects.link(obj)
    obj.parent = parent
    return obj


def person(name, location, mat, at, until, reach=1):
    """Someone at the board, drawn the way a hand draws a person: a head, shoulders, an arm out."""
    pivot = pops(hero.empty('person-' + name, location), at, until)
    arm = [V(reach * .2, 0, .5), V(reach * .44, -.03, .6), V(reach * .56, -.05, .76)]
    eye = [V(reach * .08, -.01, .9), V(reach * .08, -.01, .85)]
    stroke(f'person-{name}-ink', [FIGURE, HEAD, arm, eye], pivot, mat, LINE * 1.3, rough=False)
    filled(f'person-{name}-body', FIGURE[:-1], pivot)
    filled(f'person-{name}-head', HEAD[:-1], pivot)
    label(name, pivot, (0, 0, 1.3), .27, mat)
    return pivot


PEOPLE = [
    ('Alex', V(B.x - .95, B.y + .45, 0), MINT, B + V(-.15, -.3, .3), 1),
    ('Cris', NEW + V(-.15, -1.05, -NEW.z), None, NEW + V(.2, .1, .35), 1),
    ('Sam', V(E.x + .55, E.y - .95, 0), WARM, E + V(.35, -.05, .35), -1),
]
cursors = []
for index, (name, stands, chalk, points, reach) in enumerate(PEOPLE):
    person(name, stands, chalk, 19.9 + .45 * index, 24.0 + .12 * index, reach)
    cursor = pops(hero.empty(f'cursor-{index}', points), 20.4 + .45 * index, 24.0 + .12 * index)
    cursor['size'] = .75
    stroke(f'cursor-{index}-ink', [ARROW], cursor, chalk, LINE * 1.6, rough=False)
    cursors.append((cursor, points))
new_card = pops(card('new-card', NEW, .78, .46), 21.3)
named(new_card, 'Fraud', 21.6, .18)
new_wire = draws(growing('new-wire', [NEW + V(.39, 0, 0), V(-1.85, NEW.y, .4), V(-1.85, SERVICE.y, .25), SERVICE + V(-.72, 0, 0)]), 22.1, .8)

# 6 · Open questions: what is still unsettled stays pinned to the part it concerns.
questions = [pops(pin('question-1', E, '?', WARM, 'retries?'), 24.5), pops(pin('question-2', B, '?', WARM, 'owner?'), 25.3), pops(pin('question-3', STORE + V(0, .2, .35), '?', WARM, 'backups?'), 26.1)]

# The camera: where it looks, how far round and how steeply, and from how far.
camera_data = bpy.data.cameras.new('film')
camera_data.lens = 50
# The same height of view as before, on a wide frame, with the subject a little left of centre:
# the page pins its words, on a small note, to the bottom right.
camera_data.sensor_fit = 'VERTICAL'
camera_data.sensor_height = 33.75
camera_data.clip_start = .05
camera = bpy.data.objects.new('film', camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
# Each stop: when, what it looks at, how far round and how steeply, from how far, and how far left
# of centre the subject sits (a share of the frame's width) so the page's words have room.
MOVES = [
    # The diagram is drawn head-on in the middle of the frame: at this point it has the screen to itself.
    (0, (0, 0, 0), 0, 0, 9.4, 0),
    (2, (-1.0, .5, .3), 24, 44, 7.6, .14),
    (4, (-.4, .2, .4), 14, 50, 7.0, .14),
    (6, (.4, -.3, .6), 2, 50, 6.8, .14),
    (7.4, (B.x + 1.1, B.y, .6), -20, 50, 6.6, .14),
    (10.5, (B.x + 1.3, B.y + .1, .7), -30, 52, 6.2, .14),
    (11.8, (SERVICE.x, SERVICE.y, .2), -4, 12, 5.4, .12),
    # Straight down through the middle of the open service, clear of its outline.
    (12.8, (SERVICE.x, SERVICE.y, -1.3), 0, 1, 2.2, 0),
    (13.7, (SERVICE.x, SERVICE.y - .03, ROOM.z + .1), 0, 3, 2.9, .06),
    (15, (ROOM.x, ROOM.y, ROOM.z + .15), -16, 42, 4.0, .14),
    (16.4, (CODE.x + .7, CODE.y, CODE.z + .3), 14, 42, 4.3, .13),
    (19, (CODE.x + .9, CODE.y, CODE.z + .3), 24, 44, 4.2, .13),
    (20.9, (-1.1, -.1, .6), -22, 46, 6.6, .14),
    (23.5, (-1.3, -.2, .6), -12, 50, 6.4, .14),
    (24.7, (-.2, -.3, .9), 10, 56, 6.8, .14),
    (27.5, (0, -.2, .9), 18, 54, 6.6, .14),
    (30, (0, 0, 0), 0, 0, 13.0, .24),
]


def smooth(u):
    return u * u * u * (u * (u * 6 - 15) + 10)


def mix(a, b, u):
    return a + (b - a) * u


def look(t):
    t = max(0.0, t)
    for (t0, p0, yaw0, tilt0, d0, s0), (t1, p1, yaw1, tilt1, d1, s1) in zip(MOVES, MOVES[1:]):
        if t <= t1:
            u = smooth((t - t0) / (t1 - t0))
            target = Vector(p0).lerp(Vector(p1), u)
            yaw, tilt, distance = math.radians(mix(yaw0, yaw1, u)), math.radians(mix(tilt0, tilt1, u)), mix(d0, d1, u)
            shift = mix(s0, s1, u)
            break
    offset = Matrix.Rotation(yaw, 3, 'Z') @ Vector((0, -math.sin(tilt), math.cos(tilt))) * distance
    # A turntable: the far side of the board is always up, also when looking straight down at it.
    back = offset.normalized()
    up = Matrix.Rotation(yaw, 3, 'Z') @ Vector((0, math.cos(tilt), math.sin(tilt)))
    right = up.cross(back)
    # Step the camera sideways rather than turn it, so the subject keeps its angle but sits left of centre.
    width = 2 * distance * math.tan(math.atan(33.75 / 2 / 50)) * 16 / 9
    camera.location = target + offset + right * (shift * width)
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
    t = frame / FPS - INTRO
    hero.pose(max(0, frame - INTRO * FPS) % hero.FRAMES)
    hero.rig.rotation_euler = (0, 0, 0)
    look(t)
    for obj, at, until, back in POPS:
        size = pop(t, at) * (1 - pop(t, until) if until is not None else 1) + (pop(t, back) if back is not None else 0)
        size *= obj.get('size', 1)
        obj.scale = (size, size, size)
    for obj, at, seconds in DRAWS:
        obj.data.bevel_factor_end = smooth(max(0.0, min(1.0, (t - at) / seconds)))
        obj.hide_render = t <= at
    for trail in TRAILS:
        trail.hide_render = trail.hide_render or t > 6.5
    # The level below fades like rubbed-out chalk once the camera starts back up.
    ink = 1 - smooth(max(0.0, min(1.0, (t - BELOW) / .9)))
    for strength in FADING:
        strength.default_value = ink
    for obj in BURIED:
        if t > BELOW + .9:
            obj.scale = (0, 0, 0)
    # The small components inside the service step aside while the camera passes through to the room.
    gone = (1 - pop(t, 11.4) * (1 - pop(t, 28.2))) * pop(t, -1.2)
    hero.inside.scale = (gone * hero.near(-.75),) * 3
    request.scale = (0, 0, 0)
    if t < 0:
        for dot, *_ in hero.signals:
            dot.scale = (0, 0, 0)
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
        cursor.location = home + V(.22 * math.sin(s), .14 * math.sin(1.7 * s + index), 0) * (0.5 if index == 1 else 1)


if __name__ == '__main__':
    for frame in (ONLY or range((SECONDS + INTRO) * FPS + 1)):
        pose(frame)
        scene.frame_set(frame)
        scene.render.filepath = f'{OUT}/{frame:04d}.png'
        bpy.ops.render.render(write_still=True)
