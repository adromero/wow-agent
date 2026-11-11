// Copy the static renderer files into dist (works on Windows, macOS and Linux).
import { cpSync, rmSync } from "node:fs";

rmSync("dist/renderer", { recursive: true, force: true });
cpSync("src/renderer", "dist/renderer", { recursive: true });
