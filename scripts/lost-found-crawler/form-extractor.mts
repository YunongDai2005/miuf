import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type {
  ChannelField,
  FormControl,
} from "../../lib/lost-found-channel-schema";
import { stableHash } from "./hash.mjs";
import { inferSemanticField } from "./semantics.mjs";
import type { FormSnapshot } from "./schemas";

function compactText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function controlFor(
  elementName: string,
  type: string | undefined
): FormControl {
  if (elementName === "textarea") return "textarea";
  if (elementName === "select") return "select";
  const normalized = type?.toLowerCase() || "text";
  if (
    normalized === "date" ||
    normalized === "time" ||
    normalized === "number" ||
    normalized === "email" ||
    normalized === "tel" ||
    normalized === "radio" ||
    normalized === "checkbox" ||
    normalized === "file" ||
    normalized === "hidden"
  ) {
    return normalized;
  }
  return "text";
}

function selectorFor(
  $: cheerio.CheerioAPI,
  element: AnyNode,
  index: number
): string {
  const node = $(element);
  const id = node.attr("id");
  if (id) {
    const escapedId = id.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
    return `#${escapedId}`;
  }
  const name = node.attr("name");
  if (name) {
    const escaped = name.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return `${element.type === "tag" ? element.name : "input"}[name="${escaped}"]`;
  }
  return `${element.type === "tag" ? element.name : "input"}:nth-of-type(${index + 1})`;
}

function labelFor(
  $: cheerio.CheerioAPI,
  element: AnyNode,
  selector: string
): string {
  const node = $(element);
  const id = node.attr("id");
  const explicit = id
    ? compactText(
        $("label")
          .filter((_, label) => $(label).attr("for") === id)
          .first()
          .text()
      )
    : "";
  const wrapped = compactText(node.closest("label").first().text());
  return (
    explicit ||
    wrapped ||
    compactText(node.attr("aria-label")) ||
    compactText(node.attr("placeholder")) ||
    compactText(node.attr("name")) ||
    selector
  );
}

function helpTextFor($: cheerio.CheerioAPI, element: AnyNode): string | undefined {
  const node = $(element);
  const describedBy = compactText(node.attr("aria-describedby"));
  const described = describedBy
    .split(" ")
    .filter(Boolean)
    .map((id) => compactText($(`#${id}`).text()))
    .filter(Boolean)
    .join(" ");
  const nearby = compactText(
    node
      .closest(".form-group, .field, fieldset, li, p, div")
      .find(".help, .hint, .description, small")
      .first()
      .text()
  );
  return described || nearby || undefined;
}

function isHoneypotField(input: {
  node: cheerio.Cheerio<AnyNode>;
  label: string;
  helpText?: string;
  placeholder?: string;
}): boolean {
  const rawName = compactText(input.node.attr("name"));
  const signature = [
    rawName,
    compactText(input.node.attr("id")),
    compactText(input.node.attr("class")),
    input.label,
    input.helpText,
    input.placeholder,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    /(?:^|[\[_.-])__?hp(?:[\]_.-]|$)|honeypot|spam[-_ ]?(?:trap|shield)/i.test(
      signature
    ) ||
    /(?:do not|don'?t|please do not).{0,45}(?:fill|complete)|(?:leave|keep).{0,30}(?:blank|empty)/i.test(
      signature
    ) ||
    /(?:nicht|bitte nicht).{0,45}(?:ausfüllen|ausfuellen|füllen|fuellen)|(?:füll|fuell).{0,35}nicht.{0,20}aus|(?:leer|frei).{0,25}lassen/i.test(
      signature
    )
  );
}

function hasHumanCaptcha(
  $: cheerio.CheerioAPI,
  form: cheerio.Cheerio<AnyNode>,
  fields: ChannelField[]
): boolean {
  const hasChallengeField = fields.some(
    (field) =>
      field.control !== "hidden" &&
      /captcha|recaptcha|hcaptcha|security test|security question|sicherheits(?:test|prüfung)|word.{0,30}(?:picture|image)|wort.{0,30}bild/i.test(
        [field.rawName, field.rawId, field.label, field.helpText]
          .filter(Boolean)
          .join(" ")
      )
  );
  if (hasChallengeField) return true;

  return (
    form
      .find(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="frcapi"], .g-recaptcha, .h-captcha, .frc-captcha, .cf-turnstile, [class*="captcha"], [id*="captcha"]'
      )
      .filter((_, element) => {
        const node = $(element);
        const signature = [
          node.attr("id"),
          node.attr("class"),
          node.attr("src"),
          node.attr("title"),
        ]
          .filter(Boolean)
          .join(" ");
        return (
          node.attr("type")?.toLowerCase() !== "hidden" &&
          node.attr("aria-hidden")?.toLowerCase() !== "true" &&
          node.attr("data-size")?.toLowerCase() !== "invisible" &&
          !/recaptcha[_ -]?v3|invisible/i.test(signature)
        );
      }).length > 0
  );
}

function numberAttribute(
  node: cheerio.Cheerio<AnyNode>,
  name: string
): number | undefined {
  const value = node.attr(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractFields(
  $: cheerio.CheerioAPI,
  form: cheerio.Cheerio<AnyNode>,
  looseOnly = false
): ChannelField[] {
  const fields: ChannelField[] = [];
  form.find("input, select, textarea").each((index, element) => {
    const node = $(element);
    if (looseOnly && node.closest("form").length > 0) return;
    if (node.is(":disabled")) return;
    const inputType = node.attr("type")?.toLowerCase();
    if (
      element.name === "input" &&
      (inputType === "submit" ||
        inputType === "button" ||
        inputType === "reset" ||
        inputType === "image")
    ) {
      return;
    }
    if (node.attr("name") === "Tenant Identifier") return;
    let control = controlFor(element.name, node.attr("type"));
    const selector = selectorFor($, element, index);
    const label = labelFor($, element, selector);
    const helpText = helpTextFor($, element);
    const placeholder = compactText(node.attr("placeholder")) || undefined;
    const rawName = compactText(node.attr("name")) || undefined;
    const rawId = compactText(node.attr("id")) || undefined;
    if (
      control !== "hidden" &&
      isHoneypotField({ node, label, helpText, placeholder })
    ) {
      control = "hidden";
    }
    const semantic = inferSemanticField({
      control,
      label,
      helpText,
      placeholder,
      rawName,
    });
    const options =
      control === "select"
        ? node
            .find("option")
            .map((_, option) => ({
              value: $(option).attr("value") ?? "",
              label: compactText($(option).text()),
            }))
            .get()
            .filter((option) => option.label)
        : undefined;
    const acceptedFiles =
      control === "file"
        ? compactText(node.attr("accept"))
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined;
    const constraints = {
      pattern: compactText(node.attr("pattern")) || undefined,
      min: compactText(node.attr("min")) || undefined,
      max: compactText(node.attr("max")) || undefined,
      minLength: numberAttribute(node, "minlength"),
      maxLength: numberAttribute(node, "maxlength"),
      acceptedFiles: acceptedFiles?.length ? acceptedFiles : undefined,
    };
    const hasConstraints = Object.values(constraints).some(
      (value) => value !== undefined
    );
    fields.push({
      rawName,
      rawId,
      label,
      helpText,
      placeholder,
      control,
      required:
        node.is("[required]") ||
        node.attr("aria-required")?.toLowerCase() === "true" ||
        /\*\s*$/.test(label),
      options: options?.length ? options : undefined,
      constraints: hasConstraints ? constraints : undefined,
      step: 1,
      semanticKey: semantic.key,
      semanticConfidence: semantic.confidence,
      evidenceSelector: selector,
    });
  });
  if (fields.some((field) => field.semanticKey === "lastName")) {
    for (const field of fields) {
      if (
        field.semanticKey === "fullName" &&
        /^(name|your name|ihr name)$/i.test(field.label.trim())
      ) {
        field.semanticKey = "firstName";
        field.semanticConfidence = 0.85;
      }
    }
  }
  return fields;
}

function safeAction(pageUrl: string, action: string | undefined): string | undefined {
  if (!action) return pageUrl;
  try {
    const url = new URL(action, pageUrl);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(cHash|csrf|token|nonce|state|timestamp|_ts)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function stableUrlShape(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid|cHash|csrf|token|nonce|state|timestamp|_ts)/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  if (url.pathname !== "/") {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

export function extractFormsFromHtml(input: {
  html: string;
  pageUrl: string;
}): FormSnapshot[] {
  const $ = cheerio.load(input.html);
  const title = compactText($("title").first().text() || $("h1").first().text());
  const documentLanguage = compactText($("html").attr("lang")).split("-")[0];
  const pageText = compactText($("body").text()).toLowerCase();
  const loginRequired =
    /\b(anmelden|einloggen|login required|sign in)\b/i.test(pageText) &&
    $("input[type='password']").length > 0;
  const output: FormSnapshot[] = [];
  const appendForm = (
    form: cheerio.Cheerio<AnyNode>,
    synthetic = false
  ): void => {
    const fields = extractFields($, form, synthetic);
    if (!fields.length) return;
    const captcha = hasHumanCaptcha($, form, fields);
    if (synthetic) {
      const lostSpecificFields = new Set(
        fields
          .map((field) => field.semanticKey)
          .filter((key) =>
            [
              "lossDate",
              "lossTime",
              "lossLocation",
              "itemCategory",
              "itemDescription",
            ].includes(key)
          )
      );
      if (lostSpecificFields.size < 2) return;
    }
    const contextText = compactText(
      [
        form.text(),
        form.prevAll("h1, h2, h3, legend").first().text(),
        ...fields.map((field) =>
          [field.label, field.helpText, field.placeholder].filter(Boolean).join(" ")
        ),
      ].join(" ")
    );
    const formMethod: "GET" | "POST" =
      synthetic || form.attr("method")?.toUpperCase() === "POST" ? "POST" : "GET";
    const formAction = safeAction(
      input.pageUrl,
      synthetic ? undefined : form.attr("action")
    );
    const language = [documentLanguage || "und"];
    const canonical = {
      pageUrl: input.pageUrl,
      formAction,
      formMethod,
      title,
      contextText,
      language,
      fields,
      captcha,
      loginRequired,
    };
    const stableShape = {
      pageUrl: stableUrlShape(input.pageUrl),
      formAction: formAction ? stableUrlShape(formAction) : undefined,
      formMethod,
      language,
      fields: fields.map((field) => ({
        rawName: field.rawName,
        label: field.label,
        control: field.control,
        required: field.required,
        options: field.options,
        constraints: field.constraints,
        semanticKey: field.semanticKey,
      })),
      captcha,
      loginRequired,
    };
    output.push({
      ...canonical,
      contentHash: stableHash(stableShape),
    });
  };
  $("form").each((_, element) => {
    appendForm($(element));
  });
  const looseControls = $("input, select, textarea").filter(
    (_, element) => $(element).closest("form").length === 0
  );
  if (looseControls.length >= 2) {
    const first = looseControls.first();
    const root =
      first.closest("[role='form'], .form, [class*='form-']").first().length > 0
        ? first.closest("[role='form'], .form, [class*='form-']").first()
        : $("main, [role='main'], body").first();
    appendForm(root, true);
  }
  return output;
}
