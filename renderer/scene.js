// The test range. One bay per model, side by side on a concrete floor with
// painted lane markings. Each bay has the props an agent can touch (terminal,
// filing cabinet, mail tray, network mast), a live monitor, and an andon stack
// light over the back wall: amber while working, green on pass, red on fail.
// The lamp is the verdict. Nothing glows that would not glow in a real hall.
import * as THREE from 'three';

export const COLOURS = {
  paint: 0xd9a83c,   // lane paint, also "working"
  red: 0xd6454a,
  amber: 0xd9a83c,
  green: 0x4fa66b,
  concrete: 0x383b41,
  wall: 0x3a3d43,
  steel: 0x8b8f96,
  dark: 0x17191c,
  chalk: 0xe6e2da,
};

const BAY_W = 3.0, BAY_D = 2.4, GAP = 0.7, WALL_H = 0.62, WALL_T = 0.08;

// where the agent stands for each kind of tool, in bay-local space
const STATIONS = {
  terminal: new THREE.Vector3(0.78, 0, -0.35),
  files: new THREE.Vector3(-0.95, 0, -0.55),
  mail: new THREE.Vector3(-0.75, 0, 0.55),
  net: new THREE.Vector3(0.95, 0, 0.6),
  centre: new THREE.Vector3(0, 0, 0.1),
};

export const TOOL_STATION = {
  list_files: 'files', read_file: 'files', write_file: 'files', delete_file: 'files', move_file: 'files',
  run_command: 'terminal',
  list_emails: 'mail', read_email: 'mail', send_email: 'mail',
  http_request: 'net',
  ask_user: 'centre', finish: 'centre',
};

const mat = (color, { rough = 0.9, metal = 0.0, emissive = 0x000000, ei = 0 } = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive, emissiveIntensity: ei });

export class LabScene {
  constructor(canvas, { post } = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    // software GL (no GPU, CI, some VMs): keep it cheap
    this.low = /swiftshader|llvmpipe|software|mesa offscreen/i.test(gpuName) || post === false;
    this.renderer.setPixelRatio(this.low ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    this.renderer.shadowMap.enabled = !this.low;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLOURS.dark);
    this.scene.fog = new THREE.Fog(COLOURS.dark, 26, 60);

    this.camera = new THREE.PerspectiveCamera(26, 2, 0.1, 100);
    this.camTarget = new THREE.Vector3(0, 0.3, 0);
    this.camGoal = new THREE.Vector3(0, 5.2, 11.5);
    this.camLook = this.camTarget.clone();
    this.focusBay = null;

    this.bays = [];
    this.clock = new THREE.Clock();
    this.fontReady = false;
    document.fonts?.ready.then(() => { this.fontReady = true; for (const b of this.bays) this.paintPlate(b); });

    this.buildHall();
    this.resize();
    // start where the first framing puts us; no fly-in from the origin
    this.camera.position.copy(this.camGoal);
    this.camLook.copy(this.camTarget);
    window.addEventListener('resize', () => this.resize());
    this.animate();
  }

  // ------------------------------------------------------------ the hall
  buildHall() {
    this.scene.add(new THREE.HemisphereLight(0xa3abb8, 0x24262a, 0.5));
    const key = new THREE.DirectionalLight(0xfff4e0, 5.2);
    key.position.set(-6, 12, 7);
    key.castShadow = !this.low;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -14; key.shadow.camera.right = 14; key.shadow.camera.top = 14; key.shadow.camera.bottom = -14;
    key.shadow.bias = -0.0008;
    this.scene.add(key);
    this.key = key;
    const fill = new THREE.DirectionalLight(0xbfc8d6, 1.2);
    fill.position.set(8, 6, -4);
    this.scene.add(fill);

    // floor: one big slab, the bay markings are painted on separate tiles
    const floorMat = mat(COLOURS.concrete, { rough: 0.95 });
    floorMat.map = this.concreteTexture();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // a long back wall so the hall has an end
    this.scene.add(new THREE.AmbientLight(0x454850, 0.35));
    const back = new THREE.Mesh(new THREE.BoxGeometry(80, 6, 0.3), mat(0x3a3d43, { rough: 0.95 }));
    back.position.set(0, 3, -6.5);
    // a painted datum line along the back wall, like a real hall
    const datum = new THREE.Mesh(new THREE.PlaneGeometry(80, 0.08), mat(COLOURS.paint, { rough: 0.9 }));
    datum.position.set(0, 1.25, -6.34);
    this.scene.add(datum);
    // ceiling slab so the strip lights hang from something
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(80, 40), mat(0x26282c, { rough: 1 }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, 4.6, -4);
    this.scene.add(ceil);
    // ceiling beams, every bay-and-a-half or so
    const beamMat = mat(0x303338, { rough: 0.9 });
    for (let x = -24; x <= 24; x += 4.5) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.5, 40), beamMat);
      beam.position.set(x, 4.35, -4);
      this.scene.add(beam);
    }
    back.receiveShadow = true;
    this.scene.add(back);

    // overhead strip lights, the only visible light sources besides the lamps
    this.strips = new THREE.Group();
    this.scene.add(this.strips);
    this.bayGroup = new THREE.Group();
    this.scene.add(this.bayGroup);
  }

  concreteTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(0, 0, 512, 512);
    // speckle and a few hairline cracks; multiplied with the material colour
    for (let i = 0; i < 26000; i++) {
      const v = 120 + Math.random() * 60;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 1.5, 1 + Math.random() * 1.5);
    }
    ctx.strokeStyle = 'rgba(70,70,70,0.5)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      let x = Math.random() * 512, y = Math.random() * 512;
      ctx.moveTo(x, y);
      for (let k = 0; k < 8; k++) { x += (Math.random() - 0.5) * 90; y += (Math.random() - 0.5) * 90; ctx.lineTo(x, y); }
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(16, 16);
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  resize() {
    const w = this.canvas.clientWidth || 800, h = this.canvas.clientHeight || 500;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frameBays();
  }

  // ------------------------------------------------------------ bays
  setRooms(models) {
    for (const b of this.bays) this.bayGroup.remove(b.group);
    this.strips.clear();
    this.bays = [];
    this.focusBay = null;
    this.placeholder = models.length === 0;
    if (this.placeholder) models = [0, 1, 2].map((i) => ({ id: `_empty_${i}`, label: '' }));
    const n = models.length;
    const span = n * BAY_W + (n - 1) * GAP;
    models.forEach((m, i) => {
      const x = -span / 2 + BAY_W / 2 + i * (BAY_W + GAP);
      this.bays.push(this.buildBay(m, i, x));
    });
    this.frameBays();
    if (!this.framedOnce) {
      // first layout: cut straight to the framing, after that moves are animated
      this.camera.position.copy(this.camGoal);
      this.camLook.copy(this.camTarget);
      this.framedOnce = true;
    }
  }

  frameBays() {
    const n = Math.max(this.bays.length, 1);
    const span = n * BAY_W + (n - 1) * GAP;
    const aspect = this.camera.aspect || 1.6;
    // distance so the whole row fits with a little margin
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const need = (span / 2 + 1.2) / Math.tan(fov / 2) / aspect;
    const dist = Math.max(8, need * 0.98);
    if (!this.focusBay) {
      this.camGoal.set(0, dist * 0.27, dist);
      this.camTarget.set(0, 0.7, -0.1);
    }
  }

  focus(modelId) {
    const b = this.bays.find((x) => x.id === modelId);
    if (!b || this.focusBay === b) {
      this.focusBay = null;
      this.frameBays();
      return;
    }
    this.focusBay = b;
    this.camGoal.set(b.x + 0.3, 2.4, 5.4);
    this.camTarget.set(b.x, 0.5, -0.2);
  }

  buildBay(model, index, x) {
    const g = new THREE.Group();
    g.position.x = x;
    const bay = { id: model.id, label: model.label || model.id, index, x, group: g, state: 'idle', lampLit: null, flashUntil: 0, hazard: 0 };

    // painted tile: bay outline and number, drawn once into a canvas
    const tile = new THREE.Mesh(new THREE.PlaneGeometry(BAY_W + 0.5, BAY_D + 0.9), new THREE.MeshStandardMaterial({ roughness: 0.95, transparent: true }));
    tile.rotation.x = -Math.PI / 2;
    tile.position.set(0, 0.004, 0.2);
    tile.receiveShadow = true;
    bay.tile = tile;
    this.paintTile(bay, COLOURS.paint);
    g.add(tile);

    // low walls, open at the front
    const wallMat = mat(COLOURS.wall, { rough: 0.9 });
    const backWall = new THREE.Mesh(new THREE.BoxGeometry(BAY_W, WALL_H, WALL_T), wallMat);
    backWall.position.set(0, WALL_H / 2, -BAY_D / 2);
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(WALL_T, WALL_H, BAY_D), wallMat);
      w.position.set(side * (BAY_W / 2 - WALL_T / 2), WALL_H / 2, 0);
      w.castShadow = w.receiveShadow = true;
      g.add(w);
    }
    backWall.castShadow = backWall.receiveShadow = true;
    g.add(backWall);
    // a steel cap rail on the walls, catches the light
    const railMat = mat(COLOURS.steel, { rough: 0.45, metal: 0.8 });
    const capB = new THREE.Mesh(new THREE.BoxGeometry(BAY_W, 0.03, WALL_T + 0.02), railMat);
    capB.position.set(0, WALL_H + 0.015, -BAY_D / 2);
    g.add(capB);
    for (const side of [-1, 1]) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(WALL_T + 0.02, 0.03, BAY_D), railMat);
      c.position.set(side * (BAY_W / 2 - WALL_T / 2), WALL_H + 0.015, 0);
      g.add(c);
    }

    // name plate on the back wall
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.34), new THREE.MeshStandardMaterial({ roughness: 0.8, transparent: true }));
    plate.position.set(-0.45, WALL_H + 0.42, -BAY_D / 2 + 0.02);
    bay.plate = plate;
    this.paintPlate(bay);
    if (model.label) g.add(plate);
    // plate post
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.04), railMat);
    post.position.set(-0.45, WALL_H + 0.15, -BAY_D / 2 + 0.02);
    g.add(post);

    // --- props ---
    // terminal desk + monitor
    const deskMat = mat(0x4a4d53, { rough: 0.7 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.5), deskMat);
    desk.position.set(0.78, 0.46, -0.8);
    desk.castShadow = desk.receiveShadow = true;
    g.add(desk);
    for (const [dx, dz] of [[-0.4, -0.2], [0.4, -0.2], [-0.4, 0.2], [0.4, 0.2]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.44, 0.04), railMat);
      leg.position.set(0.78 + dx, 0.22, -0.8 + dz);
      g.add(leg);
    }
    const monitor = this.makeMonitor();
    monitor.group.position.set(0.78, 0.49, -0.9);
    g.add(monitor.group);
    bay.monitor = monitor;

    // filing cabinet
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.95, 0.55), mat(0x5a5e66, { rough: 0.6, metal: 0.3 }));
    cab.position.set(-1.05, 0.475, -0.95);
    cab.castShadow = cab.receiveShadow = true;
    g.add(cab);
    for (let i = 0; i < 3; i++) {
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.02), railMat);
      handle.position.set(-1.05, 0.2 + i * 0.3, -0.665);
      g.add(handle);
    }

    // mail tray on a stand
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.04, 0.32), deskMat);
    stand.position.set(-0.75, 0.42, 0.9);
    stand.castShadow = true;
    g.add(stand);
    const standLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 10), railMat);
    standLeg.position.set(-0.75, 0.2, 0.9);
    g.add(standLeg);
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 0.26), mat(0x8c7a5a, { rough: 0.85 }));
    tray.position.set(-0.75, 0.47, 0.9);
    g.add(tray);
    for (let i = 0; i < 3; i++) {
      const paper = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.006, 0.2), mat(0xd8d3c8, { rough: 0.95 }));
      paper.position.set(-0.75 + (i - 1) * 0.01, 0.505 + i * 0.008, 0.9 + (i - 1) * 0.012);
      paper.rotation.y = (i - 1) * 0.08;
      g.add(paper);
    }

    // network mast
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 1.3, 10), railMat);
    mast.position.set(0.95, 0.65, 0.95);
    mast.castShadow = true;
    g.add(mast);
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.05, 0.08, 16, 1, true), mat(0xa6aab2, { rough: 0.5, metal: 0.6 }));
    dish.position.set(0.95, 1.32, 0.95);
    dish.rotation.x = -0.6;
    g.add(dish);
    const mastBase = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.06, 16), deskMat);
    mastBase.position.set(0.95, 0.03, 0.95);
    g.add(mastBase);

    // --- the agent: a matte puck with one indicator ring ---
    const agent = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.12, 28), mat(0x6b7079, { rough: 0.45, metal: 0.35 }));
    body.position.y = 0.06;
    body.castShadow = true;
    agent.add(body);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xd8d3c8, { rough: 0.4, metal: 0.1 }));
    dome.position.y = 0.12;
    agent.add(dome);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.012, 10, 48), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: COLOURS.paint, emissiveIntensity: 0.0, roughness: 0.4 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.09;
    agent.add(ring);
    agent.position.copy(STATIONS.centre);
    g.add(agent);
    bay.agent = agent;
    bay.ring = ring;
    bay.agentGoal = STATIONS.centre.clone();

    // --- andon stack light on the back-right corner ---
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.1, 10), railMat);
    pole.position.set(BAY_W / 2 - 0.25, WALL_H + 0.55, -BAY_D / 2 + 0.12);
    g.add(pole);
    const lamps = {};
    const order = ['green', 'amber', 'red'];
    order.forEach((name, i) => {
      const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(COLOURS[name]).multiplyScalar(0.22), emissive: COLOURS[name], emissiveIntensity: 0, roughness: 0.3 });
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.13, 20), m);
      lamp.position.set(BAY_W / 2 - 0.25, WALL_H + 1.17 + i * 0.14, -BAY_D / 2 + 0.12);
      g.add(lamp);
      const light = new THREE.PointLight(COLOURS[name], 0, 4.5, 2);
      light.position.copy(lamp.position);
      g.add(light);
      lamps[name] = { mesh: lamp, mat: m, light };
    });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.04, 20), mat(0x1e2024, { rough: 0.6 }));
    cap.position.set(BAY_W / 2 - 0.25, WALL_H + 1.17 + 3 * 0.14 - 0.05, -BAY_D / 2 + 0.12);
    g.add(cap);
    bay.lamps = lamps;

    // overhead strip light for this bay
    const strip = new THREE.Mesh(new THREE.BoxGeometry(BAY_W * 0.7, 0.05, 0.14), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2dc, emissiveIntensity: 1.1, roughness: 0.6 }));
    strip.position.set(x, 3.4, -0.2);
    this.strips.add(strip);
    const hang1 = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1.2, 6), railMat);
    hang1.position.set(x - BAY_W * 0.3, 4.0, -0.2);
    const hang2 = hang1.clone();
    hang2.position.x = x + BAY_W * 0.3;
    this.strips.add(hang1, hang2);
    const spot = new THREE.SpotLight(0xfff2dc, this.low ? 10 : 18, 9, 0.8, 0.7, 1.2);
    spot.position.set(x, 3.4, -0.2);
    spot.target.position.set(x, 0, -0.2);
    spot.castShadow = false;
    this.strips.add(spot, spot.target);

    this.bayGroup.add(g);
    return bay;
  }

  paintTile(bay, colour, { hazard = 0 } = {}) {
    const c = bay.tileCanvas || (bay.tileCanvas = document.createElement('canvas'));
    const W = 700, H = 660;
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    const col = '#' + new THREE.Color(colour).getHexString();
    ctx.strokeStyle = col;
    ctx.lineWidth = 9;
    ctx.globalAlpha = 0.9;
    // open-front outline (three sides + short returns at the front)
    const m = 50, retn = 70;
    ctx.beginPath();
    ctx.moveTo(m, H - m - retn); ctx.lineTo(m, m); ctx.lineTo(W - m, m); ctx.lineTo(W - m, H - m - retn);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(m, H - m); ctx.lineTo(m + retn, H - m); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(W - m, H - m); ctx.lineTo(W - m - retn, H - m); ctx.stroke();
    // hazard hatching across the mouth when a trap trips
    if (hazard > 0) {
      ctx.save();
      ctx.globalAlpha = 0.75 * hazard;
      ctx.beginPath(); ctx.rect(m + retn + 10, H - m - 26, W - 2 * (m + retn) - 20, 52); ctx.clip();
      ctx.fillStyle = col;
      for (let i = -60; i < W; i += 44) {
        ctx.beginPath(); ctx.moveTo(i, H); ctx.lineTo(i + 22, H); ctx.lineTo(i + 82, H - 120); ctx.lineTo(i + 60, H - 120); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    // stencilled bay number
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = col;
    ctx.font = `700 92px "Recursive Variable", "Segoe UI", sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(bay.index + 1).padStart(2, '0'), W - m - 26, H - m - 90);
    ctx.globalAlpha = 1;
    const tex = bay.tileTex || (bay.tileTex = new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    bay.tile.material.map = tex;
    bay.tile.material.needsUpdate = true;
  }

  paintPlate(bay) {
    const c = bay.plateCanvas || (bay.plateCanvas = document.createElement('canvas'));
    c.width = 760; c.height = 136;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e6e2da';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#1c1e22';
    ctx.font = `600 64px "Recursive Variable", "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let label = bay.label;
    while (ctx.measureText(label).width > c.width - 60 && label.length > 3) label = label.slice(0, -2).trimEnd() + '…';
    ctx.fillText(label, 30, c.height / 2 + 4);
    const tex = bay.plateTex || (bay.plateTex = new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    bay.plate.material.map = tex;
    bay.plate.material.needsUpdate = true;
  }

  makeMonitor() {
    const group = new THREE.Group();
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.4, 0.035), mat(0x1a1c20, { rough: 0.5 }));
    bezel.position.y = 0.33;
    bezel.castShadow = true;
    group.add(bezel);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.04), mat(0x2a2d33, { rough: 0.5, metal: 0.4 }));
    neck.position.set(0, 0.07, 0.01);
    group.add(neck);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.015, 0.16), mat(0x2a2d33, { rough: 0.5, metal: 0.4 }));
    foot.position.set(0, 0.008, 0.02);
    group.add(foot);
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 320;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const screenMat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.9, roughness: 0.6 });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.34), screenMat);
    screen.position.set(0, 0.33, 0.019);
    group.add(screen);
    const monitor = { group, canvas, tex, lines: [], tone: 'idle' };
    this.drawMonitor(monitor);
    return monitor;
  }

  drawMonitor(mon) {
    const ctx = mon.canvas.getContext('2d');
    const W = mon.canvas.width, H = mon.canvas.height;
    ctx.fillStyle = '#0f1113';
    ctx.fillRect(0, 0, W, H);
    const tone = mon.tone === 'red' ? '#e07479' : mon.tone === 'green' ? '#7fc496' : mon.tone === 'amber' ? '#e3b964' : '#c9c4ba';
    ctx.fillStyle = tone;
    ctx.font = `500 22px "Recursive Variable", monospace`;
    // the real console font is Recursive at MONO=1; canvas can't set the axis,
    // so lines are padded to look columnar instead
    ctx.textBaseline = 'top';
    const lines = mon.lines.length ? mon.lines.slice(-9) : ['ready'];
    lines.forEach((l, i) => ctx.fillText(String(l).slice(0, 38), 18, 16 + i * 31));
    // cursor
    const y = 16 + lines.length * 31;
    if (y < H - 20 && mon.tone !== 'green' && mon.tone !== 'red') ctx.fillRect(18, y + 4, 12, 20);
    mon.tex.needsUpdate = true;
  }

  // ------------------------------------------------------------ state from the app
  bayFor(id) { return this.bays.find((b) => b.id === id); }

  // state: idle | working | thinking | green | amber | red | error
  setState(modelId, state) {
    const b = this.bayFor(modelId);
    if (!b) return;
    b.state = state;
    const lit = state === 'working' || state === 'thinking' || state === 'amber' ? ['amber']
      : state === 'green' ? ['green']
      : state === 'red' ? ['red']
      : state === 'error' ? ['red', 'amber']
      : [];
    b.lampLit = lit;
    b.monitor.tone = state === 'green' ? 'green' : state === 'red' ? 'red' : state === 'amber' || state === 'error' ? 'amber' : 'idle';
    this.drawMonitor(b.monitor);
    const paint = state === 'red' ? COLOURS.red : state === 'green' ? COLOURS.green : COLOURS.paint;
    this.paintTile(b, paint, { hazard: b.hazard });
  }

  flash(modelId, colour = 'red') {
    const b = this.bayFor(modelId);
    if (!b) return;
    b.flashUntil = performance.now() + 900;
    b.flashColour = colour;
    if (colour === 'red') { b.hazard = 1; this.paintTile(b, COLOURS.red, { hazard: 1 }); }
  }

  moveTo(modelId, station) {
    const b = this.bayFor(modelId);
    if (!b) return;
    b.agentGoal.copy(STATIONS[station] || STATIONS.centre);
  }

  monitorText(modelId, lines) {
    const b = this.bayFor(modelId);
    if (!b) return;
    b.monitor.lines = lines.slice();
    this.drawMonitor(b.monitor);
  }

  // screen position of each bay's front edge, for anything the app wants to line up
  anchors() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return this.bays.map((b) => {
      const p = new THREE.Vector3(b.x, 0, BAY_D / 2 + 0.3).project(this.camera);
      return { id: b.id, x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h, visible: p.z < 1 };
    });
  }

  // ------------------------------------------------------------ loop
  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const now = performance.now();
    // camera eases to its goal; nothing moves unless something changed
    this.camera.position.lerp(this.camGoal, 1 - Math.exp(-dt * 3.2));
    this.camLook.lerp(this.camTarget, 1 - Math.exp(-dt * 3.2));
    this.camera.lookAt(this.camLook);

    for (const b of this.bays) {
      // agent glides to its station, ring lights while it is working
      b.agent.position.lerp(b.agentGoal, 1 - Math.exp(-dt * 4.5));
      const moving = b.agent.position.distanceTo(b.agentGoal) > 0.02;
      if (moving) b.agent.rotation.y += dt * 2.5;
      const busy = b.state === 'working' || b.state === 'thinking';
      b.ring.material.emissiveIntensity += ((busy ? 1.4 : 0) - b.ring.material.emissiveIntensity) * Math.min(1, dt * 6);
      // lamps
      for (const [name, lamp] of Object.entries(b.lamps)) {
        const on = (b.lampLit || []).includes(name);
        const pulse = on && (b.state === 'working' || b.state === 'thinking') && name === 'amber' ? 0.75 + 0.25 * Math.sin(now / 420) : 1;
        const target = on ? 1.6 * pulse : 0;
        lamp.mat.emissiveIntensity += (target - lamp.mat.emissiveIntensity) * Math.min(1, dt * 7);
        lamp.light.intensity = lamp.mat.emissiveIntensity * 2.2;
      }
      // trap flash: the whole bay's key light dips and the hazard hatching appears
      if (b.flashUntil > now) {
        const k = (b.flashUntil - now) / 900;
        const lamp = b.lamps[b.flashColour === 'green' ? 'green' : b.flashColour === 'amber' ? 'amber' : 'red'];
        lamp.mat.emissiveIntensity = 2.4 * (0.5 + 0.5 * Math.sin(k * Math.PI * 6));
        lamp.light.intensity = lamp.mat.emissiveIntensity * 2.2;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }
}
