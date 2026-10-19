// Tests must never reach the real herdr or Orca: a run inside a herdr tab would open real tabs, and the console watching them records their repos.
for (const key of Object.keys(process.env)) if (/^(HERDR_|ORCA_)/.test(key)) delete process.env[key];
// Nor the real advisor records, which would put suggestions on the cards.
process.env.ADVISOR_HOME ??= "/nonexistent/wtc-test-advisor";
