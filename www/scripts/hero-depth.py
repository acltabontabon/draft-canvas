"""
Renders the hero's living whiteboard: the diagram on the board of scripts/og-illustration.png,
rebuilt in depth so it floats and the camera can drift past it.

The page lays the loop over the illustration and masks the flat diagram out of the picture, so
every shape here starts from the same coordinates the illustration uses (1672 x 941, the numbers
in src/sketchDrawing.js). Frame 0 is the flat, head-on pose: it lines up with the drawing it
replaces. The output is committed, so the site builds without Blender. To re-render:

    blender -b -P www/scripts/hero-depth.py -- /tmp/hero-depth-frames
    ffmpeg -y -framerate 24 -i /tmp/hero-depth-frames/%04d.png -an -vf gblur=sigma=0.6 \
      -c:v libx264 -profile:v high -crf 23 -preset slow -g 24 -pix_fmt yuv420p \
      -movflags +faststart www/public/clips/hero-depth.mp4

REGION is the part of the illustration the video covers; src/heroDepth.js and the stylesheet
place and mask against the same numbers.
"""

import math
import random
import re
import sys

import bpy
from mathutils import Euler, Vector

OUT = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else '/tmp/hero-depth-frames'
ONLY = [int(v) for v in sys.argv[sys.argv.index('--') + 2:]] if '--' in sys.argv else []

REGION = (560, 108, 1210, 512)  # left, top, right, bottom in illustration pixels
SCALE = 100.0  # illustration pixels per Blender unit
CX, CY = (REGION[0] + REGION[2]) / 2, (REGION[1] + REGION[3]) / 2
WIDTH, HEIGHT = (REGION[2] - REGION[0]) / SCALE, (REGION[3] - REGION[1]) / SCALE
FPS, SECONDS = 24, 8
FRAMES = FPS * SECONDS
INK = (0.93, 0.93, 0.93)  # the page's ink filter turns brightness into opacity
LINE = 0.0085
DISTANCE = 15.0  # camera to board
random.seed(7)


def near(z):
    """How much smaller something z above the board must be to cover the same pixels head-on."""
    return (DISTANCE - z) / DISTANCE


def world(px, py, z=0.0):
    """An illustration pixel, placed z above the board where the head-on camera still sees it there."""
    return Vector(((px - CX) / SCALE * near(z), -(py - CY) / SCALE * near(z), z))


def parse(d):
    """Absolute M L H V Q C Z path data to a list of illustration-pixel points."""
    tokens = re.findall(r'[MLHVQCZ]|-?\d+\.?\d*', d)
    points, i, pen, start = [], 0, (0.0, 0.0), (0.0, 0.0)
    subpaths = []

    def take(n):
        nonlocal i
        values = [float(tokens[i + k]) for k in range(n)]
        i += n
        return values

    while i < len(tokens):
        command = tokens[i]
        i += 1
        if command == 'M':
            if points:
                subpaths.append(points)
            x, y = take(2)
            pen = start = (x, y)
            points = [pen]
        elif command == 'L':
            while i < len(tokens) and tokens[i] not in 'MLHVQCZ':
                pen = tuple(take(2))
                points.append(pen)
        elif command == 'H':
            pen = (take(1)[0], pen[1])
            points.append(pen)
        elif command == 'V':
            pen = (pen[0], take(1)[0])
            points.append(pen)
        elif command == 'Q':
            while i < len(tokens) and tokens[i] not in 'MLHVQCZ':
                cx, cy, x, y = take(4)
                for s in range(1, 9):
                    t = s / 8
                    points.append(((1 - t) ** 2 * pen[0] + 2 * (1 - t) * t * cx + t * t * x,
                                   (1 - t) ** 2 * pen[1] + 2 * (1 - t) * t * cy + t * t * y))
                pen = (x, y)
        elif command == 'C':
            while i < len(tokens) and tokens[i] not in 'MLHVQCZ':
                ax, ay, bx, by, x, y = take(6)
                for s in range(1, 13):
                    t = s / 12
                    u = 1 - t
                    points.append((u ** 3 * pen[0] + 3 * u * u * t * ax + 3 * u * t * t * bx + t ** 3 * x,
                                   u ** 3 * pen[1] + 3 * u * u * t * ay + 3 * u * t * t * by + t ** 3 * y))
                pen = (x, y)
        elif command == 'Z':
            points.append(start)
            pen = start
    subpaths.append(points)
    return subpaths


def resample(points, step=0.05):
    """Even spacing along a polyline, so the pencil wobble has something to move."""
    out = [points[0]]
    for a, b in zip(points, points[1:]):
        length = (b - a).length
        count = max(1, round(length / step))
        out.extend(a.lerp(b, k / count) for k in range(1, count + 1))
    return out


def wobble(points, amount=0.007):
    """A hand never draws a ruled line: two slow waves, a different pair for every stroke."""
    phase = [random.uniform(0, math.tau) for _ in range(4)]
    out = []
    for index, point in enumerate(points):
        s = index * 0.05
        out.append(point + Vector((
            amount * (math.sin(s * 5.1 + phase[0]) + .6 * math.sin(s * 11.7 + phase[1])),
            amount * (math.sin(s * 4.3 + phase[2]) + .6 * math.sin(s * 9.9 + phase[3])),
            0)))
    return out


def material(name, colour):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    emission = nodes.new('ShaderNodeEmission')
    emission.inputs['Color'].default_value = (*[c ** 2.2 for c in colour], 1)
    output = nodes.new('ShaderNodeOutputMaterial')
    mat.node_tree.links.new(emission.outputs['Emission'], output.inputs['Surface'])
    return mat


INK_MAT = None
FAINT_MAT = None
VOID_MAT = None


def stroke(name, polylines, parent=None, mat=None, radius=LINE, rough=True):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.bevel_depth = radius
    curve.bevel_resolution = 2
    curve.use_fill_caps = True
    for points in polylines:
        points = resample(points)
        if rough:
            points = wobble(points)
        spline = curve.splines.new('POLY')
        spline.points.add(len(points) - 1)
        for target, point in zip(spline.points, points):
            target.co = (*point, 1)
    obj = bpy.data.objects.new(name, curve)
    obj.data.materials.append(mat or INK_MAT)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    return obj


def empty(name, location):
    obj = bpy.data.objects.new(name, None)
    obj.location = location
    bpy.context.scene.collection.objects.link(obj)
    return obj


def void_box(name, w, h, depth, parent):
    """An unlit body behind a shape's outline, so what is behind it stays hidden."""
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (w - .02, h - .02, depth - .01)
    obj.location = (0, 0, -depth / 2 - .006)
    obj.data.materials.append(VOID_MAT)
    obj.parent = parent
    return obj


def slab(name, left, top, right, bottom, z, depth=0.16):
    """A box on the board becomes a card with thickness."""
    centre = world((left + right) / 2, (top + bottom) / 2, z)
    pivot = empty(name, centre)
    w, h = (right - left) / SCALE * near(z), (bottom - top) / SCALE * near(z)
    corners = [Vector((-w / 2, h / 2, 0)), Vector((w / 2, h / 2, 0)), Vector((w / 2, -h / 2, 0)), Vector((-w / 2, -h / 2, 0))]
    stroke(name + '-front', [corners + [corners[0]]], pivot)
    back = [c + Vector((0, 0, -depth)) for c in corners]
    stroke(name + '-back', [back + [back[0]]] + [[c, b] for c, b in zip(corners, back)], pivot, rough=False, radius=LINE * .8)
    void_box(name + '-body', w, h, depth, pivot)
    return pivot


def scene_setup():
    scene = bpy.context.scene
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    for engine in ('BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x = 976
    scene.render.resolution_y = round(976 * HEIGHT / WIDTH / 2) * 2
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    try:
        scene.eevee.taa_render_samples = 24
    except AttributeError:
        pass
    world_data = bpy.data.worlds.new('void')
    world_data.use_nodes = True
    world_data.node_tree.nodes['Background'].inputs['Color'].default_value = (0, 0, 0, 1)
    scene.world = world_data
    return scene


scene = scene_setup()
INK_MAT = material('ink', INK)
FAINT_MAT = material('faint', tuple(c * .5 for c in INK))
VOID_MAT = material('void', (0, 0, 0))

# The camera frames REGION exactly when it faces the board; the rig turns it about the board.
rig = empty('rig', (0, 0, 0))
camera_data = bpy.data.cameras.new('camera')
camera_data.sensor_fit = 'HORIZONTAL'
camera_data.sensor_width = 36
camera_data.lens = 36 * DISTANCE / WIDTH
camera = bpy.data.objects.new('camera', camera_data)
camera.location = (0, 0, DISTANCE)
camera.parent = rig
scene.collection.objects.link(camera)
scene.camera = camera

# Cards, nearest last. Each gets its own height above the board, its own drift.
cards = [
    (slab('a', 588, 149, 650, 194, .45), 1, 0.0),
    (slab('b', 1006, 165, 1088, 224, .95), 1, 2.1),
    (slab('d', 1115, 313, 1185, 348, .6), 2, 4.0),
    (slab('e', 698, 410, 783, 455, 1.15), 1, 5.2),
]

# The service in the middle is open: an outline with its components further in.
service = empty('service', world(818.5, 304.5, .2))
outline = parse('M747 277Q746 265 761 265L879 265Q892 265 893 280L892 332Q890 344 877 344L757 344Q744 343 744 328Z')[0]
local = [(world(x, y) - world(818.5, 304.5)) * near(.2) for x, y in outline]
stroke('service-front', [local], service)
stroke('service-back', [[p + Vector((0, 0, -.22)) for p in local]], service, rough=False, radius=LINE * .7)
inside = empty('inside', world(818.5, 304.5, -.75))
inside.scale = (near(-.75),) * 3
for index, (x, y, w, h) in enumerate([(-.42, .16, .34, .2), (.1, .16, .34, .2), (-.16, -.2, .4, .2)]):
    box = [Vector((x, y, 0)), Vector((x + w, y, 0)), Vector((x + w, y - h, 0)), Vector((x, y - h, 0)), Vector((x, y, 0))]
    stroke(f'inside-{index}', [box], inside, FAINT_MAT, LINE * .8)
stroke('inside-links', [[Vector((-.08, .06, 0)), Vector((.1, .06, 0))], [Vector((-.25, -.04, 0)), Vector((-.25, -.2, 0))], [Vector((.27, -.04, 0)), Vector((.27, -.3, 0)), Vector((.24, -.3, 0))]], inside, FAINT_MAT, LINE * .8)

# The data store is a real cylinder, tipped toward the viewer the way it was drawn.
RADIUS, TILT = .435, math.radians(27)
LENGTH = .69 / math.cos(TILT)
store = empty('store', world(1003.5, 420.5, .75))
barrel = empty('barrel', (0, 0, 0))
barrel.parent = store
store.scale = (near(.75),) * 3
barrel.rotation_euler = Euler((TILT, 0, 0))
bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=RADIUS * .985, depth=LENGTH, rotation=(math.pi / 2, 0, 0))
body = bpy.context.active_object
body.data.materials.append(VOID_MAT)
body.parent = barrel


def ring(y):
    return [Vector((RADIUS * math.cos(a), y, RADIUS * math.sin(a))) for a in [math.tau * k / 72 for k in range(73)]]


stroke('store-rings', [ring(LENGTH / 2), ring(LENGTH / 2 - LENGTH * .4), ring(-LENGTH / 2)], barrel, rough=False)
stroke('store-sides', [[Vector((s * RADIUS, LENGTH / 2, 0)), Vector((s * RADIUS, -LENGTH / 2, 0))] for s in (-1, 1)], barrel, rough=False)

# Connectors climb between the heights of what they join.
wires = []
for name, d, z0, z1 in [
    ('a-service', 'M652 170H747Q779 170 779 204V264', .45, .2),
    ('a-hand', 'M627 196V240', .45, .1),
    ('hand-service', 'M690 252V292Q686 303 700 303H743', .05, .2),
    ('b-service', 'M1006 199H873Q854 199 854 219V265', .95, .2),
    ('service-store', 'M894 303H976Q998 303 998 324V372', .2, .75),
    ('service-e', 'M810 345V438Q810 450 795 450H783', .2, 1.15),
    ('service-store-low', 'M810 389Q810 403 828 403H960', .5, .75),
    ('b-d', 'M1047 224V318Q1047 338 1065 338H1072', .95, .3),
    ('d-store', 'M1151 349V437Q1151 449 1136 449H1047', .6, .75),
]:
    flat = resample([world(x, y) for x, y in parse(d)[0]])
    heights = [z0 + (z1 - z0) * (k / (len(flat) - 1)) for k in range(len(flat))]
    lifted = [Vector((p.x * near(z), p.y * near(z), z)) for p, z in zip(flat, heights)]
    stroke('wire-' + name, [lifted], rough=True)
    wires.append(lifted)

# Requests: small lights that travel the connectors, each a whole number of trips per loop.
signals = []
for wire, trips, offset, reverse in [(0, 2, 0.0, False), (3, 2, .35, False), (4, 2, .6, False), (8, 1, .2, False), (5, 1, .7, False)]:
    bpy.ops.mesh.primitive_uv_sphere_add(radius=.034, segments=16, ring_count=8)
    dot = bpy.context.active_object
    dot.data.materials.append(material('signal', (1, 1, 1)))
    signals.append((dot, wires[wire], trips, offset, reverse))


def pose(frame):
    t = frame / FRAMES
    turn = math.tau * t
    rig.rotation_euler = Euler((math.radians(-3.2) * math.sin(2 * turn), math.radians(9) * math.sin(turn), 0))
    for card, speed, phase in cards:
        card.rotation_euler = Euler((math.radians(4) * math.sin(speed * turn), math.radians(6) * math.sin(speed * turn + math.pi * (phase > 3)), 0))
        card.location.z = card.get('rest', card.location.z)
        card['rest'] = card.location.z
        card.location.z += .1 * (math.sin(speed * turn + phase) - math.sin(phase))
    store.rotation_euler = Euler((math.radians(5) * math.sin(turn), math.radians(8) * math.sin(turn), 0))
    inside.location.z = -.75 + .2 * math.sin(turn) ** 2
    for dot, wire, trips, offset, reverse in signals:
        along = (t * trips + offset) % 1
        # Ease in and out of each trip, and hide between trips so a request never teleports.
        eased = along * along * (3 - 2 * along)
        position = eased * (len(wire) - 1)
        index = min(int(position), len(wire) - 2)
        dot.location = wire[index].lerp(wire[index + 1], position - index)
        visible = math.sin(math.pi * along) ** .5
        dot.scale = (visible, visible, visible)


for frame in (ONLY or range(FRAMES)):
    pose(frame)
    scene.frame_set(frame)
    scene.render.filepath = f'{OUT}/{frame:04d}.png'
    bpy.ops.render.render(write_still=True)
