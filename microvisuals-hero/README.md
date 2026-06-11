# MicroVisuals — Hero Section

A fullscreen hero built with **Vite + React + TypeScript + Tailwind CSS**, using **gsap** for parallax and a custom video-frame boomerang for the background.

## What it does

- **Video background** that captures every frame of the source video into offscreen canvases, then plays them back forward → reverse → forward on loop (boomerang). The original `<video>` stays mounted but hidden once frames are ready.
- **Mouse parallax** on the background via gsap with smooth lerping (`0.06` damping).
- **Mounted fade-in** on the hero title and bottom row.
- **Liquid-glass** nav pill and "See templates" button — gradient border via `::before` with mask compositing.
- **Tailwind**: default `rounded` is `9999px` (full pill) by config override.

## Run it

```bash
npm install
npm run dev
```

The dev server prints a URL (usually `http://localhost:5173`).

## Production build

```bash
npm run build
npm run preview
```

## File layout

```
microvisuals-hero/
├── index.html
├── package.json
├── postcss.config.js
├── tailwind.config.js
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
└── src/
    ├── App.tsx           ← all the magic
    ├── index.css         ← fonts + liquid-glass + hero-title
    ├── main.tsx
    └── vite-env.d.ts     ← types for requestVideoFrameCallback
```

## Notes

- The Tailwind override `borderRadius.DEFAULT: '9999px'` means every `rounded` class in the markup produces a full pill. If you ever want rectangular corners on a specific element, use `rounded-md`, `rounded-lg`, etc.
- The video source is a CloudFront URL that serves CORS — `crossOrigin="anonymous"` is required so the captured frames don't taint the canvas.
- `requestVideoFrameCallback` is used when available (Chromium/Safari), with a `requestAnimationFrame` fallback for Firefox.
- Build is verified: `npm run build` produces a working bundle (`dist/`).
