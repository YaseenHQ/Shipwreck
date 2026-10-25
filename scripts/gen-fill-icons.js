const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (n) => fs.readFileSync(path.join(root, "node_modules/@phosphor-icons/react/dist/defs", n + ".es.js"), "utf8");
const fillPaths = (src) => {
  const block = src.split('"fill"')[1].split('"light"')[0];
  return [...block.matchAll(/d: "([^"]+)"/g)].map((m) => m[1]);
};
const out = { "squares-four": "SquaresFour", "clock-counter-clockwise": "ClockCounterClockwise" };
const colors = { dark: "#C5C5C5", light: "#424242" };
for (const [file, name] of Object.entries(out)) {
  const ds = fillPaths(read(name));
  for (const [theme, color] of Object.entries(colors)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="${color}">${ds.map((d) => `<path d="${d}"/>`).join("")}</svg>\n`;
    fs.writeFileSync(path.join(root, "media/icons", `${file}-fill-${theme}.svg`), svg);
    console.log("wrote", `${file}-fill-${theme}.svg`, ds.length, "paths");
  }
}
