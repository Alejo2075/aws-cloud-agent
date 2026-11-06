import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { redactString } from "@cloud-agent/evidence";

const run = promisify(execFile);
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "cdk.out",
  ".terraform",
  "dist",
  "build",
  ".aws-sam",
  "__pycache__",
  ".venv",
]);
const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|credentials|.*\.tfstate(\.backup)?|.*\.tfvars)$/i;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 256 * 1024;

export class RepoAccessError extends Error {}

/** Read-only view of an explicitly linked checkout. It cannot leave its root or read secret-bearing files. */
export class RepoReader {
  private constructor(readonly root: string) {}

  static async open(path: string): Promise<RepoReader> {
    const root = await realpath(resolve(path)).catch(() => {
      throw new RepoAccessError(`repository path does not exist: ${path}`);
    });
    if (!(await stat(root)).isDirectory())
      throw new RepoAccessError("repository path is not a directory");
    return new RepoReader(root);
  }

  async safePath(rel: string): Promise<string> {
    const abs = resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + sep))
      throw new RepoAccessError("path escapes the repository");
    const real = await realpath(abs).catch(() => abs);
    if (real !== this.root && !real.startsWith(this.root + sep))
      throw new RepoAccessError("path escapes the repository via symlink");
    if (SECRET_FILE.test(relative(this.root, real).split(sep).join("/")))
      throw new RepoAccessError("secret-bearing files are not readable");
    return real;
  }

  async listFiles(): Promise<{ files: string[]; truncated: boolean }> {
    const files: string[] = [];
    let truncated = false;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (files.length >= MAX_FILES) return void (truncated = true);
        if (e.isSymbolicLink()) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(p);
        } else {
          const rel = relative(this.root, p).split(sep).join("/");
          if (!SECRET_FILE.test(rel)) files.push(rel);
        }
      }
    };
    await walk(this.root);
    return { files: files.sort(), truncated };
  }

  /** Returns redacted text; oversized files are cut and flagged. */
  async readText(
    rel: string,
    startLine = 1,
    maxLines = 200,
  ): Promise<{ text: string; truncated: boolean; totalLines: number }> {
    const abs = await this.safePath(rel);
    const info = await stat(abs);
    if (!info.isFile()) throw new RepoAccessError("not a file");
    const raw = (await readFile(abs, "utf8")).slice(0, MAX_FILE_BYTES);
    if (raw.includes("\u0000")) throw new RepoAccessError("binary file");
    const lines = raw.split("\n");
    const slice = lines.slice(Math.max(0, startLine - 1), Math.max(0, startLine - 1) + maxLines);
    return {
      text: redactString(slice.join("\n")),
      truncated: info.size > MAX_FILE_BYTES || startLine - 1 + maxLines < lines.length,
      totalLines: lines.length,
    };
  }

  /** HEAD revision and cleanliness using fixed git arguments only. */
  async revision(): Promise<{ revision?: string; dirty?: boolean; branch?: string }> {
    const git = (args: string[]) =>
      run("git", ["-C", this.root, ...args], { timeout: 10_000 }).then((r) => r.stdout.trim());
    try {
      const [revision, status, branch] = await Promise.all([
        git(["rev-parse", "HEAD"]),
        git(["status", "--porcelain"]),
        git(["rev-parse", "--abbrev-ref", "HEAD"]),
      ]);
      return { revision, dirty: status.length > 0, branch };
    } catch {
      return {};
    }
  }
}
