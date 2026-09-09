export function collectBrowserErrors(page) {
  const errors = { console: [], page: [], request: [] };
  page.on("console", (message) => {
    if (message.type() === "error") errors.console.push(message.text());
  });
  page.on("pageerror", (error) => errors.page.push(error.message));
  page.on("requestfailed", (request) => {
    errors.request.push({
      url: request.url(),
      method: request.method(),
      message: request.failure()?.errorText ?? "unknown request failure"
    });
  });
  return errors;
}

export function hasBrowserErrors(errors) {
  return errors.console.length > 0 || errors.page.length > 0 || errors.request.length > 0;
}

