import { chromium } from "playwright";
import { extractFormsFromHtml } from "./form-extractor.mjs";
import { stableHash } from "./hash.mjs";
import { assertPublicHttpUrl } from "./safe-fetch.mjs";
import type { FormSnapshot } from "./schemas";

export interface BrowserExtraction {
  finalUrl: string;
  forms: FormSnapshot[];
  blockedWriteRequests: number;
  blockedDestinations: string[];
}

export function mergeFormSnapshots(forms: FormSnapshot[]): FormSnapshot[] {
  const groups = new Map<string, FormSnapshot[]>();
  for (const form of forms) {
    const key = [
      form.pageUrl,
      form.formAction ?? "",
      form.formMethod,
      form.title,
    ].join("|");
    const group = groups.get(key) ?? [];
    group.push(form);
    groups.set(key, group);
  }
  return [...groups.values()].map((states) => {
    if (states.length === 1) return states[0];
    const fields = states
      .flatMap((state) => state.fields)
      .filter((field, index, all) => {
        const identity = [
          field.rawName,
          field.label,
          field.control,
          field.semanticKey,
        ].join("|");
        return (
          all.findIndex(
            (candidate) =>
              [
                candidate.rawName,
                candidate.label,
                candidate.control,
                candidate.semanticKey,
              ].join("|") === identity
          ) === index
        );
      });
    const first = states[0];
    const stableShape = {
      pageUrl: first.pageUrl,
      formAction: first.formAction,
      formMethod: first.formMethod,
      language: [...new Set(states.flatMap((state) => state.language))].sort(),
      fields: fields.map((field) => ({
        rawName: field.rawName,
        label: field.label,
        control: field.control,
        required: field.required,
        options: field.options,
        constraints: field.constraints,
        step: field.step,
        semanticKey: field.semanticKey,
      })),
      captcha: states.some((state) => state.captcha),
      loginRequired: states.some((state) => state.loginRequired),
    };
    return {
      ...first,
      contextText: [...new Set(states.map((state) => state.contextText))]
        .join(" ")
        .slice(0, 20_000),
      language: stableShape.language,
      fields,
      captcha: stableShape.captcha,
      loginRequired: stableShape.loginRequired,
      contentHash: stableHash(stableShape),
    };
  });
}

export async function extractRenderedForms(
  rawUrl: string,
  options: { explore?: boolean; maxStates?: number } = {}
): Promise<BrowserExtraction> {
  const initialUrl = await assertPublicHttpUrl(rawUrl);
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-background-networking", "--disable-sync"],
    });
  } catch (error) {
    throw new Error(
      `Chromium is unavailable. Run npm run data:lost-found:browser-install first. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const blockedDestinations = new Set<string>();
  let blockedWriteRequests = 0;
  const checkedOrigins = new Map<string, Promise<void>>();
  const checkDestination = async (url: string): Promise<void> => {
    const parsed = new URL(url);
    const key = parsed.origin;
    let pending = checkedOrigins.get(key);
    if (!pending) {
      pending = assertPublicHttpUrl(parsed.toString()).then(() => undefined);
      checkedOrigins.set(key, pending);
    }
    await pending;
  };

  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: "block",
      storageState: { cookies: [], origins: [] },
    });
    await context.addInitScript(() => {
      const blocked = () => {
        throw new Error("Form submission is disabled during inspection.");
      };
      HTMLFormElement.prototype.submit = blocked;
      HTMLFormElement.prototype.requestSubmit = blocked;
      document.addEventListener(
        "submit",
        (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        true
      );
      navigator.sendBeacon = () => false;
      class DisabledWebSocket {
        constructor() {
          throw new Error("WebSocket is disabled during inspection.");
        }
      }
      Object.defineProperty(window, "WebSocket", {
        configurable: false,
        value: DisabledWebSocket,
      });
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() !== "GET" && request.method() !== "HEAD") {
        blockedWriteRequests += 1;
        await route.abort("blockedbyclient");
        return;
      }
      try {
        const target = new URL(request.url());
        let decodedUrl = request.url();
        try {
          decodedUrl = decodeURIComponent(decodedUrl);
        } catch {
          // An invalid escape sequence is harmless; inspect the raw URL instead.
        }
        if (/CodexCrawlerTest|crawler\.invalid/i.test(decodedUrl)) {
          blockedWriteRequests += 1;
          await route.abort("blockedbyclient");
          return;
        }
        if (!["http:", "https:"].includes(target.protocol)) {
          blockedDestinations.add(request.url());
          await route.abort("blockedbyclient");
          return;
        }
        await checkDestination(target.toString());
        await route.continue();
      } catch {
        blockedDestinations.add(request.url());
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    context.on("page", (openedPage) => {
      if (openedPage !== page) void openedPage.close();
    });
    await page.goto(initialUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const forms: FormSnapshot[] = [];
    const seen = new Set<string>();
    const captureState = async (step: number): Promise<boolean> => {
      let foundNewState = false;
      for (const frame of page.frames()) {
        const frameUrl = frame.url();
        if (!frameUrl.startsWith("http://") && !frameUrl.startsWith("https://")) continue;
        try {
          await assertPublicHttpUrl(frameUrl);
          const html = await frame.content();
          for (const form of extractFormsFromHtml({ html, pageUrl: frameUrl })) {
            const steppedForm = {
              ...form,
              fields: form.fields.map((field) => ({ ...field, step })),
            };
            const key = `${steppedForm.pageUrl}|${steppedForm.contentHash}`;
            if (!seen.has(key)) {
              seen.add(key);
              forms.push(steppedForm);
              foundNewState = true;
            }
          }
        } catch {
          blockedDestinations.add(frameUrl);
        }
      }
      return foundNewState;
    };

    await captureState(1);
    if (options.explore) {
      for (let state = 2; state <= (options.maxStates ?? 8); state += 1) {
        await page.evaluate(() => {
          const controls = Array.from(
            document.querySelectorAll("input, textarea, select")
          ) as unknown as Array<
            HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
          >;
          for (const control of controls) {
            if (
              control.disabled ||
              control instanceof HTMLInputElement && (
                control.type === "hidden" ||
                control.type === "file" ||
                control.type === "submit" ||
                control.type === "button"
              )
            ) {
              continue;
            }
            const searchable = [
              control.getAttribute("name"),
              control.getAttribute("id"),
              control.getAttribute("aria-label"),
              control.closest("label")?.textContent,
            ]
              .filter(Boolean)
              .join(" ");
            if (/privacy|datenschutz|consent|dsgvo|gdpr/i.test(searchable)) continue;
            if (control instanceof HTMLSelectElement) {
              const option = [...control.options].find(
                (candidate) => !candidate.disabled && candidate.value
              );
              if (option) control.value = option.value;
            } else if (
              control instanceof HTMLInputElement &&
              (control.type === "checkbox" || control.type === "radio")
            ) {
              control.checked = true;
            } else if (control instanceof HTMLInputElement && control.type === "email") {
              control.value = "crawler@crawler.invalid";
            } else if (control instanceof HTMLInputElement && control.type === "tel") {
              control.value = "+4930000000";
            } else if (control instanceof HTMLInputElement && control.type === "date") {
              control.value = "2026-01-15";
            } else if (control instanceof HTMLInputElement && control.type === "time") {
              control.value = "12:00";
            } else if (control instanceof HTMLInputElement && control.type === "number") {
              control.value = "1";
            } else {
              control.value = "CodexCrawlerTest";
            }
            control.dispatchEvent(new Event("input", { bubbles: true }));
            control.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
        let clicked = false;
        for (const frame of page.frames()) {
          const buttons = frame.getByRole("button", {
            name: /^(weiter|next|fortfahren)$/i,
          });
          for (let index = 0; index < (await buttons.count()); index += 1) {
            const button = buttons.nth(index);
            if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
            await button.click({ timeout: 5_000 }).catch(() => undefined);
            await page.waitForTimeout(300);
            clicked = true;
            break;
          }
          if (clicked) break;
        }
        if (!clicked || !(await captureState(state))) break;
      }
    }
    const finalUrl = page.url();
    await context.close();
    return {
      finalUrl,
      forms: mergeFormSnapshots(forms),
      blockedWriteRequests,
      blockedDestinations: [...blockedDestinations].sort(),
    };
  } finally {
    await browser.close();
  }
}
