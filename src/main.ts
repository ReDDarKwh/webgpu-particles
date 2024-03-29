import "./style.css";
import { makeStructuredView } from "webgpu-utils";
import particleSimShader from "./shaders/particleSimShader";
import renderParticleShader from "./shaders/renderParticleShader";
import Shader from "./shaders/shader";
import { GUI } from "dat.gui";

const { device, canvasFormat, context, settings, input } = await setup();

const WORKGROUP_SIZE = 60;
let WORKGROUP_NUM: number;
let PARTICLE_MAX_COUNT: number;
let attractors: number[][] = [[0,0,0]];

const particleComputeShader = new particleSimShader(
  WORKGROUP_SIZE,
  "Compute shader",
  device
);
const particleRenderShader = new renderParticleShader(
  "Particle shader",
  device
);

//#region Create Buffers

const { view: simulationUniforms, buffer: simulationUniformsBuffer } =
  makeUniformViewAndBuffer(particleComputeShader, "SimulationUniforms");

const {
  view: staticSimulationUniforms,
  buffer: staticSimulationUniformsBuffer,
} = makeUniformViewAndBuffer(particleComputeShader, "StaticSimulationUniforms");

const { view: globalUniforms, buffer: globalUniformsBuffer } =
  makeUniformViewAndBuffer(particleComputeShader, "GlobalUniforms");

const { view: renderUniforms, buffer: renderUniformsBuffer } =
  makeUniformViewAndBuffer(particleRenderShader, "RenderUniforms");

const texture = createParticleTexture();
const layouts = createLayouts();

const {
  commonBindGroupLayout,
  computeBindGroupLayout,
  simulationBindGroupLayout,
  particleBindGroupLayout,
  renderBindGroupLayout,
} = layouts;

const { resetPipeline, gridComputePipeline, computePipeline, renderPipeline } =
  createPipelines(layouts);

const commonBindGroup = device.createBindGroup({
  label: "Common bind group",
  layout: commonBindGroupLayout,
  entries: [
    {
      binding: 0,
      resource: { buffer: globalUniformsBuffer },
    },
  ],
});

let bindGroups: {
  bindGroup0_c: GPUBindGroup | null;
  bindGroup0: GPUBindGroup | null;
  simulationGroup: GPUBindGroup | null;
} = {
  bindGroup0: null,
  bindGroup0_c: null,
  simulationGroup: null
};

const sampler = device.createSampler({
  minFilter: "linear",
  magFilter: "linear",
});

const renderBindGroup = device.createBindGroup({
  layout: renderBindGroupLayout,
  entries: [
    {
      binding: 0,
      resource: sampler,
    },
    {
      binding: 1,
      resource: texture.createView(),
    },
    {
      binding: 2,
      resource: { buffer: renderUniformsBuffer },
    },
  ],
});

const renderPassDescriptor = {
  label: "our basic canvas renderPass",
  colorAttachments: [
    {
      clearValue: [...hexToRgb("#000000"), 1],
      loadOp: "clear",
      storeOp: "store",
    },
  ],
};

updateAttractors();
updateParticleCount();
updateRenderUniforms();
updateStaticSimulationUniforms();

let step = 0;
let oldTime = 0;
function update(time: number) {
  

  step++;

  const dt = (time - oldTime) / 1000;

  oldTime = time;

  // Set some values via set
  simulationUniforms.set({
    deltaTime: dt,
    attractorPos: input.mousePos,
    isAttractorEnabled : input.isMouseDown ? 1 : 0,
    currentFrame: step
  });

  // Upload the data to the GPU
  device.queue.writeBuffer(
    simulationUniformsBuffer,
    0,
    simulationUniforms.arrayBuffer
  );

  const encoder = device.createCommandEncoder();

  compute(encoder);
  render(encoder);

  device.queue.submit([encoder.finish()]);

 
  requestAnimationFrame(update);
}

requestAnimationFrame(update);

function compute(encoder: GPUCommandEncoder) {
  {
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, commonBindGroup);
    pass.setBindGroup(1, bindGroups.bindGroup0_c);
    pass.setBindGroup(2, bindGroups.simulationGroup);
    pass.setPipeline(resetPipeline);
    pass.dispatchWorkgroups(WORKGROUP_NUM);
    pass.setPipeline(gridComputePipeline);
    pass.dispatchWorkgroups(WORKGROUP_NUM);
    pass.setPipeline(computePipeline);
    pass.dispatchWorkgroups(WORKGROUP_NUM);
    pass.end();
  }
}

function render(encoder: GPUCommandEncoder) {
  const canvasTexture = context.getCurrentTexture();
  (renderPassDescriptor.colorAttachments[0] as any).view =
    canvasTexture.createView();

  (renderPassDescriptor.colorAttachments[0] as any).clearValue = [
    ...hexToRgb(settings.backgroundColor),
    1,
  ];

  const pass = encoder.beginRenderPass(
    renderPassDescriptor as GPURenderPassDescriptor
  );
  pass.setPipeline(renderPipeline);
  pass.setBindGroup(0, commonBindGroup);
  pass.setBindGroup(1, bindGroups.bindGroup0);
  pass.setBindGroup(2, renderBindGroup);
  pass.draw(6, PARTICLE_MAX_COUNT); // 6 vertices
  pass.end();
}

function createPipelines({
  commonBindGroupLayout,
  computeBindGroupLayout,
  simulationBindGroupLayout,
  particleBindGroupLayout,
  renderBindGroupLayout,
}: {
  commonBindGroupLayout: GPUBindGroupLayout;
  computeBindGroupLayout: GPUBindGroupLayout;
  simulationBindGroupLayout: GPUBindGroupLayout;
  particleBindGroupLayout: GPUBindGroupLayout;
  renderBindGroupLayout: GPUBindGroupLayout;
}) {
  const resetPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [
        commonBindGroupLayout,
        computeBindGroupLayout,
        simulationBindGroupLayout,
      ],
    }),
    compute: {
      module: particleComputeShader.module,
      entryPoint: "reset",
    },
  });

  const gridComputePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [
        commonBindGroupLayout,
        computeBindGroupLayout,
        simulationBindGroupLayout,
      ],
    }),
    compute: {
      module: particleComputeShader.module,
      entryPoint: "c0",
    },
  });

  const computePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [
        commonBindGroupLayout,
        computeBindGroupLayout,
        simulationBindGroupLayout,
      ],
    }),
    compute: {
      module: particleComputeShader.module,
      entryPoint: "c1",
    },
  });

  const renderPipeline = device.createRenderPipeline({
    label: "Particle render pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [
        commonBindGroupLayout,
        particleBindGroupLayout,
        renderBindGroupLayout,
      ],
    }),
    vertex: {
      module: particleRenderShader.module,
      entryPoint: "vertexMain",
    },
    fragment: {
      module: particleRenderShader.module,
      entryPoint: "fragmentMain",
      targets: [
        {
          format: canvasFormat,
          blend: {
            color: {
              operation: 'add',
              srcFactor: 'one',
              dstFactor: 'one',
            },
            alpha: {
              operation: 'add',
              srcFactor: 'one',
              dstFactor: 'one',
            },
          },
        },
      ],
    },
  });
  return {
    resetPipeline,
    gridComputePipeline,
    computePipeline,
    renderPipeline,
  };
}

function createLayouts() {
  const particleBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: {
          type: "read-only-storage",
        },
      },
    ],
  });

  const commonBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX,
        buffer: {
          type: "uniform",
        },
      },
    ],
  });

  const computeBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "storage",
        },
      },
    ],
  });

  const simulationBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "uniform",
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "uniform",
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: "read-only-storage",
        },
      },
    ],
  });

  const renderBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: {
          type: "filtering",
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: "float",
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX,
        buffer: {
          type: "uniform",
        },
      },
    ],
  });

  return {
    commonBindGroupLayout,
    computeBindGroupLayout,
    simulationBindGroupLayout,
    particleBindGroupLayout,
    renderBindGroupLayout,
  };
}

function createParticleTexture() {
  const ctx = new OffscreenCanvas(32, 32).getContext("2d")!;

  const grd = ctx.createRadialGradient(16, 16, 10, 16, 16, 16);
  grd.addColorStop(0, "rgba(255,255,255,200)");
  grd.addColorStop(1, "rgba(255,255,255,0)");

  // Draw a filled Rectangle
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 32, 32);

  const texture = device.createTexture({
    size: [32, 32],
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  device.queue.copyExternalImageToTexture(
    { source: ctx.canvas, flipY: true },
    { texture, premultipliedAlpha: true },
    [32, 32]
  );
  return texture;
}

function shuffle(a: any[]){
  return a.map(value => ({ value, sort: Math.random() }))
  .sort((a, b) => a.sort - b.sort)
  .map(({ value }) => value);
}


function addAttractor(pos: number[], dir: number){
  attractors.push([...pos, dir]);
  updateAttractors();
}

function clearAttractors(){
  attractors = [[0,0,0]];
  updateAttractors();
}

function updateAttractors(){
  
  const attractorsView = makeStructuredView(particleComputeShader.storages.attractors, new ArrayBuffer(attractors.length * 4 * 4));

  const buffer = device.createBuffer({
    size: attractorsView.arrayBuffer.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  attractorsView.set(attractors);

  bindGroups.simulationGroup = device.createBindGroup({
    label: "simulationBindGroup",
    layout: simulationBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: { buffer: simulationUniformsBuffer },
      },
      {
        binding: 1,
        resource: { buffer: staticSimulationUniformsBuffer },
      },
      {
        binding: 2,
        resource: { buffer: buffer},
      },
    ],
  });

  device.queue.writeBuffer(buffer, 0, attractorsView.arrayBuffer);
}

function updateParticleCount() {
  WORKGROUP_NUM = Math.ceil(settings.particleCount / WORKGROUP_SIZE);

  PARTICLE_MAX_COUNT = WORKGROUP_SIZE * WORKGROUP_NUM;

  const GRID_SIZE_IN_CELLS = GetGridSize({
    particleCount: PARTICLE_MAX_COUNT,
    canvasWidth: context.canvas.width,
    canvasHeight: context.canvas.height,
  });

  const GRID_CELL_SIZE_X = context.canvas.width / GRID_SIZE_IN_CELLS[0];
  const GRID_CELL_SIZE_Y = context.canvas.height / GRID_SIZE_IN_CELLS[1];

  console.log(GRID_CELL_SIZE_X, GRID_CELL_SIZE_Y);

  const particleStorageSizeInBytes =
    particleComputeShader.structs["Particle"].size * PARTICLE_MAX_COUNT;

  globalUniforms.set({
    canvasSize: [context.canvas.width, context.canvas.height],
    particleSize: settings.particleSize,
    gridCellSizeInPixels: [GRID_CELL_SIZE_X, GRID_CELL_SIZE_Y],
    gridSize: GRID_SIZE_IN_CELLS,
  });

  device.queue.writeBuffer(globalUniformsBuffer, 0, globalUniforms.arrayBuffer);

  const particleStorageBuffer = device.createBuffer({
    label: "Particle storage buffer",
    size: particleStorageSizeInBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const particleHeadsStorageBuffer = device.createBuffer({
    label: "Particle heads storage buffer",
    size: PARTICLE_MAX_COUNT * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const particleListsStorageBuffer = device.createBuffer({
    label: "Particle lists storage buffer",
    size: PARTICLE_MAX_COUNT * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const particleView = makeStructuredView(
    particleComputeShader.storages["particles"],
    new ArrayBuffer(particleStorageSizeInBytes)
  );

  for (let i = 0; i < PARTICLE_MAX_COUNT; ++i) {
    const angle = rand() * 2 * Math.PI;

    switch (settings.startingPosition) {
      case "random":
        particleView.views[i].nextPos.set([
          rand(0, context.canvas.width),
          rand(0, context.canvas.height),
        ]);
        break;
      case "ring":
        particleView.views[i].nextPos.set([
          context.canvas.width / 2,
          context.canvas.height / 2,
        ]);
        break;
    }

    particleView.views[i].cellIndexStart = [Math.floor(Math.random() * 3), Math.floor(Math.random() * 3)];

    particleView.views[i].mass.set([rand(settings.minMass, settings.maxMass)]);
    particleView.views[i].collisionOtherIndex.set([-1]);

    particleView.views[i].cellsOffsetsX.set(shuffle([0,-1, 1]));
    particleView.views[i].cellsOffsetsY.set(shuffle([0,-1, 1]));

    const speed = settings.speed;
    particleView.views[i].nextVel.set([
      Math.cos(angle) * speed,
      Math.sin(angle) * speed,
    ]);

    //clearAttractors();
  }

  device.queue.writeBuffer(particleStorageBuffer, 0, particleView.arrayBuffer);

  bindGroups.bindGroup0_c = device.createBindGroup({
    label: "bindGroup0_c",
    layout: computeBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: { buffer: particleStorageBuffer },
      },
      {
        binding: 1,
        resource: { buffer: particleHeadsStorageBuffer },
      },
      {
        binding: 2,
        resource: { buffer: particleListsStorageBuffer },
      },
    ],
  });

  bindGroups.bindGroup0 = device.createBindGroup({
    label: "bindGroup0",
    layout: particleBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: { buffer: particleStorageBuffer },
      },
    ],
  });
}

function hexToRgb(hex: string) {
  var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [
        parseInt(result[1], 16) / 255,
        parseInt(result[2], 16) / 255,
        parseInt(result[3], 16) / 255,
      ]
    : [0, 0, 0];
}

async function setup() {
  const appElement = document.querySelector<HTMLDivElement>("#app")!;
  appElement.innerHTML = `
  <canvas id="overlay"></canvas>
  <canvas id="render"></canvas>
  `;

  const canvas = document.querySelector("#render") as HTMLCanvasElement;
  const overlay = document.querySelector("#overlay") as HTMLCanvasElement;

  if (!canvas) {
    throw new Error("Yo! No canvas found.");
  }

  if (!navigator.gpu) {
    throw new Error("WebGPU not supported on this browser.");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No appropriate GPUAdapter found.");
  }

  const device = await adapter.requestDevice();

  const context = canvas.getContext("webgpu");

  canvas.width = appElement.clientWidth;
  canvas.height = appElement.clientHeight;

  overlay.width = appElement.clientWidth;
  overlay.height = appElement.clientHeight;

  const overlayContext = overlay.getContext("2d")!;

  if (!context) {
    throw new Error("Yo! No Canvas GPU context found.");
  }

  const offset = (el: HTMLElement) => {
    var rect = el.getBoundingClientRect(),
      scrollLeft = window.pageXOffset || document.documentElement.scrollLeft,
      scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    return { top: rect.top + scrollTop, left: rect.left + scrollLeft };
  };

  const canvasOffset = offset(canvas);

  const input = {
    isMouseDown: false,
    mousePos: [0,0]
  };

  document.addEventListener("mousemove", (event: MouseEvent) => {
    const mp = [
      Math.max(0, Math.min(event.clientX - canvasOffset.left, canvas.width)),
      Math.max(0, Math.min(canvas.height - (event.clientY - canvasOffset.top), canvas.height)),
    ];
    input.mousePos = mp;
  });

  document.addEventListener("mousedown", (ev) => {

    if(ev.shiftKey){
      addAttractor(input.mousePos, 1);
    } else if(ev.ctrlKey){
      addAttractor(input.mousePos, -1);
    } else {
      input.isMouseDown = true;
    }
  });

  document.addEventListener("mouseup", () => {
    input.isMouseDown = false;
  });

  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device: device,
    format: canvasFormat,
  });

  const getPresetJSON = () => {
    return JSON.parse(`
    {
      "preset": "BloopBlurp",
      "closed": false,
      "remembered": {
        "Default": {
          "0": {
            "particleCount": 60000,
            "speed": 100,
            "particleSize": 1,
            "minMass": 1,
            "maxMass": 10,
            "color1": "#FFFFFF",
            "color2": "#ff0000",
            "backgroundColor": "#000000",
            "attractorMass": 1000000,
            "tempOnHit": 0.6,
            "cooldownRate": 0.3,
            "CoefficientOfRestitution": 0.5,
            "MaxCollisionsPerFrame": 1,
            "startingPosition": "random"
          }
        },
        "JiggleZoom": {
          "0": {
            "particleCount": 60000,
            "speed": 300,
            "particleSize": 1,
            "minMass": 1,
            "maxMass": 10,
            "color1": "#00b360",
            "color2": "#000000",
            "backgroundColor": "#000000",
            "attractorMass": 1000000,
            "tempOnHit": 0.1,
            "cooldownRate": 1,
            "CoefficientOfRestitution": 0.6,
            "MaxCollisionsPerFrame": 2,
            "startingPosition": "ring"
          }
        },
        "QuirkFactor": {
          "0": {
            "particleCount": 300000,
            "speed": 30,
            "particleSize": 1,
            "minMass": 1,
            "maxMass": 50,
            "color1": "#d4530d",
            "color2": "#390000",
            "backgroundColor": "#090000",
            "attractorMass": 1000000,
            "tempOnHit": 0.03,
            "cooldownRate": 2,
            "CoefficientOfRestitution": 1,
            "MaxCollisionsPerFrame": 2,
            "startingPosition": "random"
          }
        },
        "BloopBlurp": {
          "0": {
            "particleCount": 600060,
            "speed": 200,
            "particleSize": 1,
            "minMass": 1,
            "maxMass": 50,
            "color1": "#d4530d",
            "color2": "#390000",
            "backgroundColor": "#090000",
            "attractorMass": 10000,
            "tempOnHit": 0.03,
            "cooldownRate": 2,
            "CoefficientOfRestitution": 0.9,
            "MaxCollisionsPerFrame": 5,
            "startingPosition": "ring"
          }
        }
      },
      "folders": {
        "Attractors": {
          "preset": "Default",
          "closed": false,
          "folders": {}
        },
        "Collisions": {
          "preset": "Default",
          "closed": false,
          "folders": {}
        },
        "Looks": {
          "preset": "Default",
          "closed": false,
          "folders": {}
        },
        "Particles": {
          "preset": "Default",
          "closed": false,
          "folders": {}
        }
      }
    }
    `);
  }

  const gui = new GUI({load: getPresetJSON(), preset:"JiggleZoom"});

  const settings = {
    particleCount: 60 * 100,
    update: () => {},
    gridSizeX: 0,
    gridSizeY: 0,
    speed: 10,
    color1: "#FFFFFF",
    color2: "#000000",
    backgroundColor: "#000000",
    tempOnHit: 0.6,
    cooldownRate: 0.3,
    particleSize: 1,
    minMass: 1,
    maxMass: 10,
    attractorMass: 20,
    startingPosition: "random",
    CoefficientOfRestitution:0.5,
    MaxCollisionsPerFrame: 5,
    restart: updateParticleCount,
    clearAttractors:clearAttractors
  };
  
  
  const attractors = gui.addFolder("Attractors");
  const collisions = gui.addFolder("Collisions");
  const looks = gui.addFolder("Looks")
  const particles = gui.addFolder("Particles");


  gui.useLocalStorage = true;
  gui.remember(settings);
  particles
    .add(settings, "particleCount", 0, undefined, 60)
    .onChange(updateParticleCount);
    particles.add(settings, "speed").onChange(updateParticleCount);
    particles.add(settings, "particleSize").onChange(updateParticleCount);
    collisions.add(settings, "minMass").onChange(updateParticleCount);
    collisions.add(settings, "maxMass").onChange(updateParticleCount);
    looks.addColor(settings, "color1").onChange(updateRenderUniforms);
    looks.addColor(settings, "color2").onChange(updateRenderUniforms);
    looks.addColor(settings, "backgroundColor");
    attractors.add(settings, "attractorMass").onChange(updateStaticSimulationUniforms);
  looks.add(settings, "tempOnHit").onChange(updateStaticSimulationUniforms);
  looks.add(settings, "cooldownRate").onChange(updateStaticSimulationUniforms);
  collisions.add(settings, "CoefficientOfRestitution").onChange(updateStaticSimulationUniforms);
  collisions.add(settings, "MaxCollisionsPerFrame").onChange(updateStaticSimulationUniforms);
  
  particles
    .add(settings, "startingPosition", ["random", "ring"])
    .onChange(updateParticleCount);
  gui.add(settings, "restart");
  gui.add(settings, "clearAttractors");

  return { device, canvasFormat, context, overlayContext, settings, input };
}

function updateRenderUniforms() {
  renderUniforms.set({
    color1: hexToRgb(settings.color1),
    color2: hexToRgb(settings.color2),
  });

  device.queue.writeBuffer(renderUniformsBuffer, 0, renderUniforms.arrayBuffer);
}

function updateStaticSimulationUniforms() {
  staticSimulationUniforms.set({
    tempOnHit: settings.tempOnHit,
    cooldownRate: settings.cooldownRate,
    attractorMass : settings.attractorMass,
    E: settings.CoefficientOfRestitution,
    maxColl: settings.MaxCollisionsPerFrame
  });

  device.queue.writeBuffer(
    staticSimulationUniformsBuffer,
    0,
    staticSimulationUniforms.arrayBuffer
  );
}

function rand(min = 0, max = 1) {
  return min + Math.random() * (max - min);
}

function makeUniformViewAndBuffer(shader: Shader, structName: string) {
  const view = makeStructuredView(shader.structs[structName]);
  return {
    view,
    buffer: device.createBuffer({
      size: view.arrayBuffer.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
  };
}

function GetGridSize({
  particleCount,
  canvasWidth,
  canvasHeight,
}: {
  particleCount: number;
  canvasWidth: number;
  canvasHeight: number;
}): number[] {
  const factors = (number: number) =>
    [...Array(number + 1).keys()].filter((i) => number % i === 0);

  const ratio = (w: number, h: number) => Math.max(w, h) / Math.min(w, h);

  const cr = ratio(canvasWidth, canvasHeight);

  const f = factors(particleCount);
  const sf = f.slice(0, Math.ceil(f.length / 2));

  const c = sf
    .map((x, i) => [x, f[f.length - 1 - i]])
    .reduce((a, b) =>
      Math.abs(ratio(a[0], a[1]) - cr) < Math.abs(ratio(b[0], b[1]) - cr)
        ? a
        : b
    );

  return canvasWidth > canvasHeight
    ? [Math.max(c[0], c[1]), Math.min(c[0], c[1])]
    : [Math.min(c[0], c[1]), Math.max(c[0], c[1])];
}
