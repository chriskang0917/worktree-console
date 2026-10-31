// Tests must never reach the real herdr, Herdr app or Orca: a run inside one of their tabs would open real tabs, and the console watching them records their repos.
for (const key of Object.keys(process.env)) if (/^(HERDR_|HC_|ORCA_)/.test(key)) delete process.env[key];
// Nor the real advisor records, which would put suggestions on the cards.
process.env.ADVISOR_HOME ??= "/nonexistent/wtc-test-advisor";
// Nor the real dev-flow run folders, which would move the stage column.
process.env.SARA_DEV_FLOW_HOME ??= "/nonexistent/wtc-test-sara-dev-flow";
