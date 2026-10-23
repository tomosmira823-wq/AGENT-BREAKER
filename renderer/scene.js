// Three.js lab: a row of glass rooms, one per model. Each room has a ceiling
// light that tracks the agent's state and a glowing orb that moves between
// four stations (files, terminal, mail, network) as the agent uses tools.
import * as THREE from '../node_modules/three/build/three.module.js';

const COLOURS = {
  idle: 0x3a4660,
  working: 0x3d7cff,
  thinking: 0x8a6cff,
  red: 0xff3b4a,
  amber: 0xffb020,
  green: 0x2ee6a6,
  grey: 0x222a3a,
};

const STATIONS = {
  files: new THREE.Vector3(-0.62, 0.22, -0.45),
  terminal: new THREE.Vector3(0.62, 0.22, -0.45),
  mail: new THREE.Vector3(-0.62, 0.22, 0.45),
  net: new THREE.Vector3(0.62, 0.22, 0.45),
  centre: new THREE.Vector3(0, 0.22, 0),
};

export const TOOL_STATION = {
  list_files: 'files', read_file: 'files', write_file: 'files', delete_file: 'files', move_file: 'files',
  run_command: 'terminal',
  list_emails: 'mail', read_email: 'mail', send_email: 'mail',
  http_request: 'net',
  ask_user: 'centre', finish: 'centre',
};

export class LabScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x07090f, 0.06);
    this.camera = new THREE.PerspectiveCamera(32, 2, 0.1, 100);
    this.rooms = [];
    this.clock = new THREE.Clock();
    this.scene.add(new THREE.HemisphereLight(0x5b6b99, 0x05070c, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 0.35);
    key.position.set(4, 8, 6);
    this.scene.add(key);
    // floor
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 20), new THREE.MeshStandardMaterial({ color: 0x0b0f1a, roughness: 0.9, metalness: 0.1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.3;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(80, 80, 0x1a2338, 0x121a2b);
    grid.position.y = -0.29;
    this.scene.add(grid);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.animate();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.frameRooms();
  }

  setRooms(models) {
    for (const r of this.rooms) this.scene.remove(r.group);
    this.rooms = [];
    const spacing = 2.4;
    const offset = ((models.length - 1) * spacing) / 2;
    models.forEach((m, i) => {
      const room = this.buildRoom(m);
      room.group.position.x = i * spacing - offset;
      this.scene.add(room.group);
      this.rooms.push(room);
    });
    this.frameRooms();
  }

  frameRooms() {
    const n = Math.max(1, this.rooms.length);
    const width = n * 2.4 + 0.6;
    const height = 2.1;
    const aspect = this.camera.aspect || 2;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const distH = width / 2 / (tanV * aspect);
    const distV = height / 2 / tanV;
    const dist = Math.max(distH, distV) * 1.08 + 0.5;
    this.camera.position.set(0, 0.7 + dist * 0.16, dist);
    this.camera.lookAt(0, 0.25, 0);
  }

  buildRoom(model) {
    const group = new THREE.Group();
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fc4ff, opacity: 0.09, transparent: true, roughness: 0.2, metalness: 0.4, depthWrite: false, side: THREE.DoubleSide });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 1.3, 1.5), glass);
    box.position.y = 0.35;
    group.add(box);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: 0x4d64a0, transparent: true, opacity: 0.9 }));
    edges.position.copy(box.position);
    group.add(edges);
    // floor slab + state glow underneath
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2, 0.06, 1.5), new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.6 }));
    slab.position.y = -0.27;
    group.add(slab);
    const glowMat = new THREE.MeshBasicMaterial({ color: COLOURS.idle, transparent: true, opacity: 0.22 });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.8), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.285;
    group.add(glow);
    // ceiling light strip
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x222a3a, emissive: COLOURS.idle, emissiveIntensity: 0.6, roughness: 0.4 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 0.18), panelMat);
    panel.position.y = 0.96;
    group.add(panel);
    const light = new THREE.PointLight(COLOURS.idle, 1.2, 4, 2);
    light.position.y = 0.85;
    group.add(light);
    // stations
    const stationMat = new THREE.MeshStandardMaterial({ color: 0x1f2a44, roughness: 0.5, metalness: 0.3 });
    const stations = {};
    for (const [name, pos] of Object.entries(STATIONS)) {
      if (name === 'centre') continue;
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.3), stationMat.clone());
      s.position.set(pos.x, -0.16, pos.z);
      group.add(s);
      const screen = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.02), new THREE.MeshStandardMaterial({ color: 0x0b1222, emissive: 0x1d3f7a, emissiveIntensity: 0.6 }));
      screen.position.set(pos.x, 0.02, pos.z + (pos.z < 0 ? 0.14 : -0.14));
      group.add(screen);
      stations[name] = s;
    }
    // agent orb
    const orbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: COLOURS.working, emissiveIntensity: 1.6, roughness: 0.2 });
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 24, 24), orbMat);
    orb.position.copy(STATIONS.centre);
    group.add(orb);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 16), new THREE.MeshBasicMaterial({ color: COLOURS.working, transparent: true, opacity: 0.18 }));
    halo.position.copy(orb.position);
    group.add(halo);
    const orbLight = new THREE.PointLight(COLOURS.working, 0.9, 1.8, 2);
    orbLight.position.copy(orb.position);
    group.add(orbLight);

    return {
      model,
      group, box, edges, panel, panelMat, glowMat, light, orb, orbMat, halo, orbLight, stations,
      state: 'idle',
      target: STATIONS.centre.clone(),
      flash: 0,
      flashColour: COLOURS.red,
      bob: Math.random() * 10,
      visible: true,
    };
  }

  roomFor(modelId) {
    return this.rooms.find((r) => r.model.id === modelId);
  }

  // state: idle | working | thinking | red | amber | green | grey
  setState(modelId, state) {
    const r = this.roomFor(modelId);
    if (!r) return;
    r.state = state;
    const c = COLOURS[state] ?? COLOURS.idle;
    r.panelMat.emissive.setHex(c);
    r.glowMat.color.setHex(c);
    r.light.color.setHex(c);
    r.edges.material.color.setHex(state === 'red' ? 0x8a2430 : state === 'green' ? 0x1f7a5f : state === 'amber' ? 0x8a6218 : 0x3b4c74);
  }

  flash(modelId, colour = 'red') {
    const r = this.roomFor(modelId);
    if (!r) return;
    r.flash = 1;
    r.flashColour = COLOURS[colour] ?? COLOURS.red;
  }

  moveTo(modelId, station) {
    const r = this.roomFor(modelId);
    if (!r) return;
    r.target = (STATIONS[station] || STATIONS.centre).clone();
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    for (const r of this.rooms) {
      r.orb.position.lerp(r.target, 1 - Math.pow(0.001, dt));
      r.orb.position.y = r.target.y + Math.sin(t * 3 + r.bob) * 0.03;
      r.halo.position.copy(r.orb.position);
      r.orbLight.position.copy(r.orb.position);
      const working = r.state === 'working' || r.state === 'thinking';
      r.orbMat.emissiveIntensity = working ? 1.4 + Math.sin(t * 6 + r.bob) * 0.5 : 0.8;
      r.halo.material.opacity = working ? 0.15 + Math.sin(t * 6 + r.bob) * 0.08 : 0.08;
      const base = COLOURS[r.state] ?? COLOURS.idle;
      if (r.flash > 0) {
        r.flash = Math.max(0, r.flash - dt * 1.6);
        const k = r.flash;
        const mixed = new THREE.Color(base).lerp(new THREE.Color(r.flashColour), Math.min(1, k * 1.5));
        r.panelMat.emissive.copy(mixed);
        r.glowMat.color.copy(mixed);
        r.glowMat.opacity = 0.22 + k * 0.4;
        r.light.color.copy(mixed);
        r.panelMat.emissiveIntensity = 0.6 + k * 2.4;
        r.light.intensity = 1.2 + k * 6;
      } else {
        r.panelMat.emissiveIntensity = working ? 0.7 + Math.sin(t * 2 + r.bob) * 0.15 : 0.6;
        r.glowMat.opacity = working ? 0.2 + Math.sin(t * 2 + r.bob) * 0.06 : 0.22;
        r.light.intensity = 1.2;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }
}
