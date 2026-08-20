(() => {
  if (globalThis.__berlinLostFoundHelperInstalled) return;
  globalThis.__berlinLostFoundHelperInstalled = true;

  const dispatchValue = (element, value, control) => {
    if (control === "select" && element instanceof HTMLSelectElement) {
      const normalized = value.trim().toLowerCase();
      const option = [...element.options].find(
        (candidate) =>
          candidate.value === value ||
          candidate.label.trim().toLowerCase() === normalized
      );
      if (!option) return false;
      element.value = option.value;
    } else if (
      (control === "checkbox" || control === "radio") &&
      element instanceof HTMLInputElement
    ) {
      return false;
    } else if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      element.value = value;
    } else {
      return false;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };

  const findElement = (selector) => {
    if (typeof selector !== "string" || !selector) return null;
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  };

  const validatePayload = (payload, requireSubmit) => {
    if (
      payload?.version !== 1 ||
      typeof payload.submitAllowed !== "boolean" ||
      typeof payload.channelId !== "string" ||
      payload.channelId.length > 200 ||
      !/^[a-f0-9]{16}$/.test(payload.fingerprint || "") ||
      !Array.isArray(payload.fields) ||
      payload.fields.length > 100
    ) {
      throw new Error("This package is not supported.");
    }
    if (
      !Array.isArray(payload.manualRequiredFields) ||
      payload.manualRequiredFields.length > 100
    ) {
      throw new Error(
        "This submission package predates required-field safety checks. Copy a fresh package."
      );
    }
    const expectedOrigin = new URL(payload.pageUrl).origin;
    if (expectedOrigin !== location.origin) {
      throw new Error(`This package belongs to ${expectedOrigin}, not this website.`);
    }
    const expectedPath =
      new URL(payload.pageUrl).pathname.replace(/\/+$/, "") || "/";
    const currentPath = location.pathname.replace(/\/+$/, "") || "/";
    if (expectedPath !== currentPath) {
      throw new Error(
        `This package belongs to ${expectedPath}, not the current page.`
      );
    }
    const createdAt = Date.parse(payload.createdAt);
    const expiresAt = Date.parse(payload.expiresAt);
    if (
      !Number.isFinite(createdAt) ||
      !Number.isFinite(expiresAt) ||
      createdAt > Date.now() + 5 * 60 * 1000 ||
      expiresAt <= createdAt ||
      expiresAt - createdAt > 2 * 60 * 60 * 1000 + 60 * 1000
    ) {
      throw new Error("This package has invalid validity dates.");
    }
    if (expiresAt < Date.now()) {
      throw new Error("This package has expired. Copy a fresh one from the app.");
    }
    const adapters = globalThis.BERLIN_LOST_FOUND_ADAPTERS || [];
    const adapter = payload.adapterId
      ? adapters.find(
          (entry) =>
            entry.id === payload.adapterId &&
            entry.channelId === payload.channelId &&
            entry.origin === location.origin &&
            entry.testedContentHash === payload.formContentHash
        )
      : null;
    if (payload.adapterId && !adapter) {
      throw new Error("The reviewed form adapter is missing or no longer matches.");
    }
    if (!payload.submitAllowed && requireSubmit) {
      throw new Error("Automatic submission is not approved for this channel.");
    }
    if (!adapter) return null;
    let pathMatches = false;
    try {
      pathMatches = new RegExp(adapter.pathPattern).test(location.pathname);
    } catch {
      pathMatches = false;
    }
    if (!pathMatches) throw new Error("The adapter does not apply to this page.");
    if (requireSubmit && adapter.capability !== "reviewed_submit") {
      throw new Error("This adapter is approved for filling only, not submission.");
    }
    return adapter;
  };

  const fillPackage = (payload) => {
    const adapter = validatePayload(payload, false);
    let filled = 0;
    let missing = 0;
    for (const field of payload.fields) {
      if (
        typeof field?.selector !== "string" ||
        typeof field?.value !== "string" ||
        field.control === "file" ||
        field.control === "hidden"
      ) {
        missing += 1;
        continue;
      }
      const element = findElement(field.selector);
      if (element && dispatchValue(element, field.value, field.control)) filled += 1;
      else missing += 1;
    }
    return {
      filled,
      missing,
      canSubmit:
        Boolean(payload.submitAllowed) &&
        adapter?.capability === "reviewed_submit" &&
        missing === 0,
    };
  };

  const currentValueMatches = (element, expected) => {
    if (element instanceof HTMLSelectElement) {
      return element.value === expected;
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      return element.value === expected;
    }
    return false;
  };

  const manualFieldIsComplete = (element) => {
    if (element instanceof HTMLSelectElement) return Boolean(element.value);
    if (element instanceof HTMLTextAreaElement) {
      return Boolean(element.value.trim());
    }
    if (!(element instanceof HTMLInputElement)) return false;
    if (element.type === "checkbox") return element.checked;
    if (element.type === "radio") {
      if (!element.name) return element.checked;
      return [...document.querySelectorAll('input[type="radio"]')].some(
        (candidate) =>
          candidate instanceof HTMLInputElement &&
          candidate.name === element.name &&
          candidate.checked
      );
    }
    if (element.type === "file") return Boolean(element.files?.length);
    return Boolean(element.value.trim());
  };

  const validateFilledState = (payload) => {
    const issues = [];
    for (const field of payload.fields) {
      const element = findElement(field?.selector);
      if (
        !element ||
        typeof field?.value !== "string" ||
        !currentValueMatches(element, field.value)
      ) {
        issues.push(field?.label || "an autofilled field");
      }
    }
    for (const field of payload.manualRequiredFields || []) {
      const element = findElement(field?.selector);
      if (!element || !manualFieldIsComplete(element)) {
        issues.push(field?.label || "a required manual field");
      }
    }
    if (issues.length) {
      throw new Error(
        `Review these fields before submission: ${[...new Set(issues)]
          .slice(0, 8)
          .join(", ")}.`
      );
    }
  };

  const waitForSuccess = async (adapter) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const selectorMatch = adapter.successSelector
        ? document.querySelector(adapter.successSelector)
        : null;
      const textMatch = adapter.successText
        ? document.body?.innerText.includes(adapter.successText)
        : false;
      if (selectorMatch || textMatch) {
        const receipt = adapter.receiptSelector
          ? document.querySelector(adapter.receiptSelector)?.textContent?.trim()
          : undefined;
        return { receipt };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("The website did not show the reviewed success state.");
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (
      message?.type !== "BERLIN_LOST_FOUND_FILL" &&
      message?.type !== "BERLIN_LOST_FOUND_SUBMIT"
    ) {
      return;
    }
    void (async () => {
      let submissionAttempted = false;
      let payload;
      try {
        payload = message.payload;
        if (message.type === "BERLIN_LOST_FOUND_FILL") {
          const result = fillPackage(payload);
          sendResponse({ ok: true, ...result });
          return;
        }
        const adapter = validatePayload(payload, true);
        validateFilledState(payload);
        const storageKey = `submission:${payload.fingerprint}`;
        const previous = await chrome.storage.local.get(storageKey);
        const previousAttempt = previous[storageKey];
        const previousTime = Date.parse(
          previousAttempt?.confirmedAt || previousAttempt?.attemptedAt || ""
        );
        if (
          previousAttempt?.status === "confirmed" ||
          (Number.isFinite(previousTime) &&
            Date.now() - previousTime < 24 * 60 * 60 * 1000)
        ) {
          throw new Error(
            "This exact report already has a submission attempt. Check the official website before retrying."
          );
        }
        if (
          !window.confirm(
            "Submit this lost-property report now? The extension will click the reviewed final button once."
          )
        ) {
          throw new Error("Submission cancelled.");
        }
        const submitButton = findElement(adapter.submitSelector);
        if (!(submitButton instanceof HTMLElement)) {
          throw new Error("The reviewed submit button is no longer present.");
        }
        await chrome.storage.local.set({
          [storageKey]: {
            status: "pending",
            attemptedAt: new Date().toISOString(),
            channelId: payload.channelId,
          },
        });
        submissionAttempted = true;
        submitButton.click();
        const result = await waitForSuccess(adapter);
        await chrome.storage.local.set({
          [storageKey]: {
            status: "confirmed",
            confirmedAt: new Date().toISOString(),
            channelId: payload.channelId,
            receipt: result.receipt,
          },
        });
        const updatedAt = new Date().toISOString();
        const outcome = {
          version: 1,
          channelId: payload.channelId,
          fingerprint: payload.fingerprint,
          status: result.receipt
            ? "receipt_confirmed"
            : "user_confirmed",
          updatedAt,
          receipt: result.receipt,
        };
        sendResponse({ ok: true, receipt: result.receipt, outcome });
      } catch (error) {
        const outcome =
          submissionAttempted &&
          typeof payload?.channelId === "string" &&
          typeof payload?.fingerprint === "string"
            ? {
                version: 1,
                channelId: payload.channelId,
                fingerprint: payload.fingerprint,
                status: "uncertain",
                updatedAt: new Date().toISOString(),
              }
            : undefined;
        sendResponse({
          ok: false,
          attempted: submissionAttempted,
          outcome,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return true;
  });
})();
