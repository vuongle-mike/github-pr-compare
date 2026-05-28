import { createServer } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 4173);
const ROOT = process.cwd();
const PUBLIC_DIR = resolve(ROOT, "public");
const VENDOR_DIR = resolve(ROOT, "cloned-sites/editor.mergely.com");
const CACHE_DIR = resolve(ROOT, ".cache/pr-compare");
const MAX_FILE_BYTES = 1_500_000;
const sessions = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      await sendFile(res, join(PUBLIC_DIR, "index.html"), PUBLIC_DIR);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pr/compare") {
      await handleCompare(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/pr/file") {
      await handleFile(url, res);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/vendor/")) {
      const filePath = join(VENDOR_DIR, decodeURIComponent(url.pathname.slice("/vendor/".length)));
      await sendFile(res, filePath, VENDOR_DIR);
      return;
    }

    if (req.method === "GET") {
      const requestPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const filePath = join(PUBLIC_DIR, requestPath);
      await sendFile(res, filePath, PUBLIC_DIR);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: cleanError(error) });
  }
});

await mkdir(CACHE_DIR, { recursive: true });
server.listen(PORT, () => {
  console.log(`GitHub PR Compare running at http://localhost:${PORT}`);
});

async function handleCompare(req, res) {
  const body = await readJson(req);
  const prUrl = String(body.prUrl || "").trim();
  const baseBranch = String(body.baseBranch || "master").trim();
  const parsed = parsePullRequestUrl(prUrl);

  validateBranchName(baseBranch);

  const sessionId = randomUUID();
  const workdir = join(CACHE_DIR, sessionId);
  await mkdir(workdir, { recursive: true });

  try {
    const pr = await ghJson([
      "pr",
      "view",
      prUrl,
      "--json",
      "number,title,url,state,baseRefName,headRefName,headRefOid,mergeCommit"
    ]);
    const token = await ghToken();
    const remoteUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;

    await run("git", ["init", "--quiet"], { cwd: workdir });
    await run("git", ["remote", "add", "origin", remoteUrl], { cwd: workdir });

    const refspecs = [
      `+refs/heads/${baseBranch}:refs/remotes/origin/base`,
      `+refs/pull/${parsed.number}/head:refs/remotes/origin/pr`
    ];
    if (pr.state === "MERGED" && pr.mergeCommit?.oid) {
      refspecs.push(`+${pr.mergeCommit.oid}:refs/remotes/origin/pr-merge`);
    }

    await gitFetch(workdir, token, refspecs, { depth: 100 });

    const baseSha = await gitOut(["rev-parse", "refs/remotes/origin/base"], workdir);
    const headSha = await gitOut(["rev-parse", "refs/remotes/origin/pr"], workdir);
    const mergeBaseSha = await resolveMergeBase(workdir, token, refspecs);
    const compare = await resolveCompareRange(workdir, pr, mergeBaseSha, headSha);
    const files = await listChangedFiles(workdir, compare.leftSha, compare.rightSha);

    const session = {
      id: sessionId,
      workdir,
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.number,
      prUrl: pr.url || prUrl,
      title: pr.title || `PR #${parsed.number}`,
      baseBranch,
      baseSha,
      mergeBaseSha,
      compareLeftSha: compare.leftSha,
      compareRightSha: compare.rightSha,
      compareMode: compare.mode,
      headSha,
      headRefName: pr.headRefName || `PR #${parsed.number}`,
      files,
      filesByPath: new Map(files.map((file) => [file.path, file]))
    };
    sessions.set(sessionId, session);

    sendJson(res, 200, publicSession(session));
  } catch (error) {
    await rm(workdir, { recursive: true, force: true });
    throw error;
  }
}

async function handleFile(url, res) {
  const sessionId = url.searchParams.get("sessionId") || "";
  const path = url.searchParams.get("path") || "";
  const session = sessions.get(sessionId);

  if (!session) {
    return sendJson(res, 404, { error: "Compare session not found. Submit the PR again." });
  }

  const file = session.filesByPath.get(path);
  if (!file) {
    return sendJson(res, 404, { error: "File is not part of this compare session." });
  }

  if (file.binary) {
    return sendJson(res, 200, {
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      binary: true,
      unsupported: true,
      left: "",
      right: ""
    });
  }

  const leftPath = file.oldPath || file.path;
  const rightPath = file.path;
  let left = "";
  let right = "";
  try {
    left = file.status === "A" ? "" : await readGitText(session.workdir, session.compareLeftSha, leftPath);
    right = file.status === "D" ? "" : await readGitText(session.workdir, session.compareRightSha, rightPath);
  } catch (error) {
    if (error.code !== "UNSUPPORTED_FILE") throw error;
    return sendJson(res, 200, {
      path: file.path,
      oldPath: file.oldPath,
      status: file.status,
      binary: true,
      unsupported: true,
      left: "",
      right: ""
    });
  }

  sendJson(res, 200, {
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    binary: false,
    unsupported: false,
    left,
    right
  });
}

async function listChangedFiles(workdir, baseSha, headSha) {
  const raw = await gitOut(["diff", "--name-status", "-M", "-z", baseSha, headSha], workdir, {
    encoding: "buffer",
    maxBuffer: 50 * 1024 * 1024
  });
  const parts = raw.toString("utf8").split("\0").filter(Boolean);
  const files = [];

  for (let index = 0; index < parts.length; index += 1) {
    const statusToken = parts[index];
    const status = statusToken[0];
    let oldPath = null;
    let path = parts[index + 1];

    if (status === "R" || status === "C") {
      oldPath = parts[index + 1];
      path = parts[index + 2];
      index += 2;
    } else {
      index += 1;
    }

    const stats = await fileStats(workdir, baseSha, headSha, path);
    files.push({
      path,
      oldPath,
      status,
      additions: stats.additions,
      deletions: stats.deletions,
      binary: stats.binary
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function resolveCompareRange(workdir, pr, mergeBaseSha, headSha) {
  if (pr.state !== "MERGED" || !pr.mergeCommit?.oid || mergeBaseSha !== headSha) {
    return { leftSha: mergeBaseSha, rightSha: headSha, mode: "merge-base" };
  }

  const mergeSha = await gitOut(["rev-parse", "refs/remotes/origin/pr-merge"], workdir);
  const parentLine = await gitOut(["rev-list", "--parents", "-n", "1", mergeSha], workdir);
  const parents = parentLine.split(/\s+/).slice(1);
  const firstParent = parents[0];

  if (!firstParent) {
    return { leftSha: mergeBaseSha, rightSha: headSha, mode: "merge-base" };
  }

  return { leftSha: firstParent, rightSha: mergeSha, mode: "merged-pr" };
}

async function fileStats(workdir, baseSha, headSha, path) {
  const output = await gitOut(["diff", "--numstat", "-M", baseSha, headSha, "--", path], workdir);
  const firstLine = output.split("\n").find(Boolean);
  if (!firstLine) return { additions: 0, deletions: 0, binary: false };

  const [added, deleted] = firstLine.split("\t");
  const binary = added === "-" || deleted === "-";
  return {
    additions: binary ? 0 : Number(added || 0),
    deletions: binary ? 0 : Number(deleted || 0),
    binary
  };
}

async function readGitText(workdir, sha, path) {
  const { stdout } = await execFileAsync("git", ["show", `${sha}:${path}`], {
    cwd: workdir,
    encoding: "buffer",
    maxBuffer: MAX_FILE_BYTES + 1
  });

  if (stdout.length > MAX_FILE_BYTES || stdout.includes(0)) {
    const error = new Error("File is binary or too large to render.");
    error.code = "UNSUPPORTED_FILE";
    throw error;
  }

  return stdout.toString("utf8");
}

async function resolveMergeBase(workdir, token, refspecs) {
  const deepenSteps = [200, 500, 1000, 5000];

  for (let attempt = 0; attempt <= deepenSteps.length; attempt += 1) {
    try {
      return await gitOut(["merge-base", "refs/remotes/origin/base", "refs/remotes/origin/pr"], workdir);
    } catch (error) {
      if (attempt === deepenSteps.length) break;
      await gitFetch(workdir, token, refspecs, { deepen: deepenSteps[attempt] });
    }
  }

  if ((await isShallowRepository(workdir)) === "true") {
    await gitFetch(workdir, token, refspecs, { unshallow: true });
    return gitOut(["merge-base", "refs/remotes/origin/base", "refs/remotes/origin/pr"], workdir);
  }

  throw userError("Could not find a merge base between the selected base branch and PR branch.");
}

async function isShallowRepository(workdir) {
  try {
    return await gitOut(["rev-parse", "--is-shallow-repository"], workdir);
  } catch {
    return "false";
  }
}

async function gitFetch(workdir, token, refspecs, options = {}) {
  const authHeader = Buffer.from(`x-access-token:${token}`).toString("base64");
  const depthArgs = [];
  if (options.unshallow) depthArgs.push("--unshallow");
  else if (options.deepen) depthArgs.push(`--deepen=${options.deepen}`);
  else if (options.depth) depthArgs.push(`--depth=${options.depth}`);

  await run(
    "git",
    [
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${authHeader}`,
      "fetch",
      "--no-tags",
      ...depthArgs,
      "origin",
      ...refspecs
    ],
    {
      cwd: workdir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 20 * 1024 * 1024
    }
  );
}

async function ghJson(args) {
  const output = await run("gh", args, { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(output);
}

async function ghToken() {
  return run("gh", ["auth", "token"]);
}

async function gitOut(args, cwd, options = {}) {
  return run("git", args, { cwd, ...options });
}

async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd || ROOT,
    env: options.env || process.env,
    encoding: options.encoding || "utf8",
    maxBuffer: options.maxBuffer || 5 * 1024 * 1024
  });
  return typeof stdout === "string" ? stdout.trim() : stdout;
}

function publicSession(session) {
  return {
    sessionId: session.id,
    repo: `${session.owner}/${session.repo}`,
    prNumber: session.prNumber,
    prUrl: session.prUrl,
    title: session.title,
    baseBranch: session.baseBranch,
    baseSha: session.baseSha,
    mergeBaseSha: session.mergeBaseSha,
    compareLeftSha: session.compareLeftSha,
    compareRightSha: session.compareRightSha,
    compareMode: session.compareMode,
    headSha: session.headSha,
    headRefName: session.headRefName,
    files: session.files,
    totals: session.files.reduce(
      (totals, file) => {
        totals.additions += file.additions;
        totals.deletions += file.deletions;
        totals.files += 1;
        return totals;
      },
      { files: 0, additions: 0, deletions: 0 }
    )
  };
}

function parsePullRequestUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw userError("Enter a valid GitHub pull request URL.");
  }

  if (url.hostname !== "github.com") {
    throw userError("Only github.com pull request URLs are supported.");
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([0-9]+)\/?$/);
  if (!match) {
    throw userError("URL must look like https://github.com/owner/repo/pull/123.");
  }

  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3])
  };
}

function validateBranchName(branch) {
  if (!branch) throw userError("Base branch is required.");
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || branch.includes("@{")) {
    throw userError("Base branch contains unsupported characters.");
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw userError("Request body must be valid JSON.");
  }
}

async function sendFile(res, filePath, rootDir) {
  const safePath = resolve(normalize(filePath));
  if (safePath !== rootDir && !safePath.startsWith(rootDir + sep)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }

  try {
    await readFile(safePath);
    res.writeHead(200, {
      "cache-control": "no-store",
      "content-type": MIME[extname(safePath)] || "application/octet-stream"
    });
    createReadStream(safePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function cleanError(error) {
  if (error?.stderr) return String(error.stderr).trim() || error.message;
  return error?.message || "Unexpected error";
}

function userError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
