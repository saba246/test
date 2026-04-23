// Run with: node generate-icons.js
// Generates simple PNG icons using Canvas API (Node canvas or browser)
// Since we don't have canvas in Node without extra deps, we use a data-URI approach.
// Instead, include pre-made SVG icons and reference them or use this script in a browser.

// For loading as unpacked extension, Chrome accepts PNG icons.
// This script outputs the base64 of minimal valid PNGs for 16, 48, 128px.

const { createCanvas } = require('canvas');
const fs = require('fs');

[16, 48, 128].forEach((size) => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background circle
  ctx.fillStyle = '#1e293b';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Microphone icon (simplified)
  ctx.strokeStyle = '#60a5fa';
  ctx.lineWidth = Math.max(1, size / 14);
  ctx.lineCap = 'round';

  const cx = size / 2;
  const unit = size / 16;

  // Mic body
  ctx.beginPath();
  ctx.roundRect(cx - 2 * unit, 2 * unit, 4 * unit, 7 * unit, unit);
  ctx.stroke();

  // Mic stand arc
  ctx.beginPath();
  ctx.arc(cx, 7 * unit, 4 * unit, Math.PI, 0, true);
  ctx.stroke();

  // Vertical line
  ctx.beginPath();
  ctx.moveTo(cx, 11 * unit);
  ctx.lineTo(cx, 13 * unit);
  ctx.stroke();

  // Base line
  ctx.beginPath();
  ctx.moveTo(cx - 2.5 * unit, 13 * unit);
  ctx.lineTo(cx + 2.5 * unit, 13 * unit);
  ctx.stroke();

  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(`icons/icon${size}.png`, buf);
  console.log(`icons/icon${size}.png written`);
});
