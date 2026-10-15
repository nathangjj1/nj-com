import { chromium } from "playwright";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const LOGIN_URL = "https://www.evaautomotive.co.uk/login";
const SEARCH_URL =
  "https://www.evaautomotive.co.uk/search?filter-valuationDateFrom=Past%2030%20Days&filter-sortBy=ValuationDate&filter-sortByDirection=DESC";
const SEARCH_API = "https://valuation.evaautomotive.co.uk/api/v1/valuation/search";
const PUBLIC_IMAGE_BASE = "https://nathanjobson.com/eva-appraisals/images";
const WINDOW_DAYS = 30;
const MAX_PAGES = 50;

const root = process.cwd();
const outDir = path.join(root, "eva-appraisals");
const imageDir = path.join(outDir, "images");
const debugDir = path.join(root, "playwright-debug");

const email = process.env.EVA_EMAIL || "";
const password = process.env.EVA_PASSWORD || "";

function requireCredentials() {
  if (!email || !password) {
    throw new Error(
      "EVA_EMAIL and EVA_PASSWORD are required. Add them as GitHub Actions repository secrets, then run this workflow again.",
    );
  }
}

function normaliseRegistration(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function withinWindow(date) {
  if (!date) return true;
  const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return date.getTime() >= cutoff;
}

function resolveImageUrl(value) {
  if (!value || typeof value !== "string") return null;
  if (value.startsWith("https://") || value.startsWith("http://")) return value;
  if (value.startsWith("//")) return `https:${value}`;
  const trimmed = value.replace(/^\/+/, "");
  if (trimmed.includes("private/")) {
    return `https://res.cloudinary.com/evavaluations/image/${trimmed}`;
  }
  return `https://res.cloudinary.com/evavaluations/image/private/${trimmed}`;
}

function extensionFor(buffer, contentType) {
  const type = (contentType || "").toLowerCase();
  if (type.includes("webp") || (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46)) {
    return "webp";
  }
  if (type.includes("png") || buffer[0] === 0x89) return "png";
  if (type.includes("gif") || (buffer[0] === 0x47 && buffer[1] === 0x49)) return "gif";
  return "jpg";
}

function asAppraisal(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const registration = normaliseRegistration(record.Vrm || record.vrm || record.Vehicle?.Vrm);
  if (registration.length < 2 || registration.length > 8) return null;
  const appraisedAt = parseDate(record.ValuationDate || record.AppraisalDate || record.CreatedOn);
  const imageUrl = resolveImageUrl(
    record.FrontBeautyShotUrl || record.Vehicle?.FrontBeautyShotUrl || record.vehicleImageUrl,
  );
  return { registration, appraisedAt, imageUrl };
}

function searchApiUrl(pageNumber) {
  const params = new URLSearchParams({
    pageNumber: String(pageNumber),
    sortBy: "ValuationDate",
    sortByDirection: "DESC",
    valuationDateFrom: "Past 30 Days",
  });
  return `${SEARCH_API}?${params.toString()}`;
}

async function findVisible(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const roots = [page, ...page.frames()];
    for (const rootFrame of roots) {
      for (const selector of selectors) {
        const locator = rootFrame.locator(selector).first();
        try {
          if (await locator.isVisible()) return { locator, rootFrame };
        } catch {
          // A frame can detach while Azure AD B2C is redirecting.
        }
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function clearPasswords(page) {
  const roots = [page, ...page.frames()];
  for (const rootFrame of roots) {
    const fields = rootFrame.locator('input[type="password"]');
    const count = await fields.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      await fields.nth(index).fill("").catch(() => {});
    }
  }
}

async function screenshot(page, name) {
  await mkdir(debugDir, { recursive: true });
  await page.screenshot({ path: path.join(debugDir, name), fullPage: false }).catch(() => {});
}

function blockedSignInReason(text) {
  if (/block cookies/i.test(text)) {
    return "Azure AD B2C blocked this browser because cookies are unavailable.";
  }
  if (/captcha|verify you are human|i'm not a robot/i.test(text)) {
    return "Azure AD B2C asked for a captcha. The job stops.";
  }
  if (/verification code|authenticator|multi-factor|one-time code|approve sign in/i.test(text)) {
    return "Azure AD B2C asked for MFA. The job stops.";
  }
  return null;
}

async function signIn(page) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  const login = page.getByTestId("login");
  await login.waitFor({ state: "visible", timeout: 30000 });
  await login.click();

  const emailField = await findVisible(
    page,
    ["#signInName", 'input[name="signInName"]', 'input[type="email"]', 'input[placeholder="Email Address"]'],
    45000,
  );
  if (!emailField) {
    await clearPasswords(page);
    await screenshot(page, "login.png");
    throw new Error("The eVA login page did not show an email field.");
  }

  const passwordField = await findVisible(
    page,
    ["#password", 'input[name="password"]', 'input[type="password"]'],
    15000,
  );
  if (!passwordField) {
    await clearPasswords(page);
    await screenshot(page, "login.png");
    throw new Error("The eVA login page did not show a password field.");
  }

  await emailField.locator.fill(email);
  await passwordField.locator.fill(password);

  const submit = await findVisible(
    page,
    ["#next", 'button:has-text("Sign in")', 'button[type="submit"]'],
    10000,
  );
  if (!submit) {
    await clearPasswords(page);
    await screenshot(page, "login.png");
    throw new Error("The eVA login page did not show a sign-in button.");
  }
  await submit.locator.click();

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const current = page.url();
    if (current.includes("www.evaautomotive.co.uk") && !current.includes("b2clogin.com") && !current.includes("/login")) {
      return;
    }
    const text = await page.locator("body").innerText().catch(() => "");
    const reason = blockedSignInReason(text);
    if (reason) {
      await clearPasswords(page);
      await screenshot(page, "login.png");
      throw new Error(reason);
    }
    await page.waitForTimeout(500);
  }

  await clearPasswords(page);
  await screenshot(page, "login.png");
  throw new Error("Sign-in did not return to eVA. If B2C asked for MFA or a captcha, the job stops.");
}

async function fetchSearchPages(request, authorization) {
  const collected = [];
  const seen = new Set();
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const response = await request.get(searchApiUrl(pageNumber), {
      headers: {
        Authorization: authorization,
        Accept: "application/json",
      },
      timeout: 60000,
    });
    if (!response.ok()) {
      throw new Error(`Valuation search returned HTTP ${response.status()} on page ${pageNumber}.`);
    }
    const body = await response.json();
    const valuations = Array.isArray(body?.Valuations) ? body.Valuations : [];
    if (valuations.length === 0) break;
    let added = 0;
    for (const record of valuations) {
      const id = record.ValuationID || record.AppraisalID || `${record.Vrm}|${record.ValuationDate}`;
      if (seen.has(id)) continue;
      seen.add(id);
      collected.push(record);
      added += 1;
    }
    if (added === 0) break;
    const total = Number(body.SearchCount ?? body.Count ?? 0);
    if (total > 0 && collected.length >= total) break;
  }
  return collected;
}

function keepLatest(records) {
  const byRegistration = new Map();
  for (const record of records) {
    const appraisal = asAppraisal(record);
    if (!appraisal || !withinWindow(appraisal.appraisedAt)) continue;
    const existing = byRegistration.get(appraisal.registration);
    if (!existing) {
      byRegistration.set(appraisal.registration, appraisal);
      continue;
    }
    const existingTime = existing.appraisedAt ? existing.appraisedAt.getTime() : 0;
    const nextTime = appraisal.appraisedAt ? appraisal.appraisedAt.getTime() : 0;
    if (nextTime >= existingTime) byRegistration.set(appraisal.registration, appraisal);
  }
  return [...byRegistration.values()].sort((left, right) => {
    const leftTime = left.appraisedAt ? left.appraisedAt.getTime() : 0;
    const rightTime = right.appraisedAt ? right.appraisedAt.getTime() : 0;
    return rightTime - leftTime;
  });
}

async function downloadImage(page, request, appraisal) {
  if (!appraisal.imageUrl) return null;
  const response = await request.get(appraisal.imageUrl, { timeout: 60000 }).catch(() => null);
  if (response?.ok()) {
    const buffer = Buffer.from(await response.body());
    return saveImage(appraisal.registration, buffer, response.headers()["content-type"]);
  }

  const fetched = await page
    .evaluate(async (url) => {
      const result = await fetch(url, { credentials: "include" });
      if (!result.ok) return null;
      const bytes = new Uint8Array(await result.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return { type: result.headers.get("content-type"), b64: btoa(binary) };
    }, appraisal.imageUrl)
    .catch(() => null);
  if (!fetched?.b64) return null;
  return saveImage(appraisal.registration, Buffer.from(fetched.b64, "base64"), fetched.type);
}

async function saveImage(registration, buffer, contentType) {
  if (!buffer || buffer.length < 32 || buffer[0] === 0x3c) return null;
  const filename = `${registration}.${extensionFor(buffer, contentType)}`;
  await writeFile(path.join(imageDir, filename), buffer);
  const existing = await readdir(imageDir).catch(() => []);
  for (const name of existing) {
    if (name.startsWith(`${registration}.`) && name !== filename) {
      await rm(path.join(imageDir, name), { force: true });
    }
  }
  return filename;
}

async function existingImage(registration) {
  const existing = await readdir(imageDir).catch(() => []);
  return existing.find((name) => name.startsWith(`${registration}.`)) || null;
}

async function removeStaleImages(keep) {
  const existing = await readdir(imageDir).catch(() => []);
  for (const name of existing) {
    const registration = name.replace(/\.[^.]+$/, "");
    if (!keep.has(registration)) {
      await rm(path.join(imageDir, name), { force: true });
    }
  }
}

async function writeFeed(appraisals) {
  const payload = {
    source: "https://www.evaautomotive.co.uk/",
    captured: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    appraisals: appraisals.map((appraisal) => ({
      registration: appraisal.registration,
      appraisedAt: appraisal.appraisedAt ? appraisal.appraisedAt.toISOString() : null,
      image: appraisal.filename ? `${PUBLIC_IMAGE_BASE}/${appraisal.filename}` : null,
    })),
  };
  await writeFile(path.join(outDir, "appraisals.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  requireCredentials();
  await mkdir(imageDir, { recursive: true });
  await mkdir(debugDir, { recursive: true });

  let authorization = "";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("request", (request) => {
    const header = request.headers().authorization;
    if (header && request.url().includes("valuation.evaautomotive.co.uk")) authorization = header;
  });

  try {
    await signIn(page);
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    const deadline = Date.now() + 30000;
    while (!authorization && Date.now() < deadline) {
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2000);
    await screenshot(page, "search.png");

    if (!authorization) {
      throw new Error("Signed in, but eVA did not send an authorised valuation request. See the search screenshot artifact.");
    }

    const records = await fetchSearchPages(context.request, authorization);
    const appraisals = keepLatest(records);
    const saved = new Set();
    let imagesSaved = 0;
    for (const appraisal of appraisals) {
      const filename = (await downloadImage(page, context.request, appraisal)) || (await existingImage(appraisal.registration));
      appraisal.filename = filename;
      if (filename) {
        saved.add(appraisal.registration);
        imagesSaved += 1;
      }
    }
    await removeStaleImages(saved);
    await writeFeed(appraisals);
    console.log(`Saved ${appraisals.length} appraisals and ${imagesSaved} images from the past ${WINDOW_DAYS} days.`);
  } catch (error) {
    await clearPasswords(page);
    if (!(await readFile(path.join(debugDir, "login.png")).then(() => true).catch(() => false))) {
      await screenshot(page, "search.png");
    }
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "eVA scrape failed.");
  process.exitCode = 1;
});
