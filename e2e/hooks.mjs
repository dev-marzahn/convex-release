// The e2e scenarios' hook, mounted into the containers at /hooks.mjs:
//   CONVEX_RELEASE_PRE_PUSH="node /hooks.mjs pre-push"
//
//   pre-push, post-apply  print what the deployment has recorded, read with the
//                         CONVEX_URL and CONVEX_ADMIN_KEY convex-release passes;
//   fail                  exit 3.
//
// It prints the URL, never the key, so the scenarios can check that the key
// isn't in the logs.
const [step] = process.argv.slice(2);
const url = process.env.CONVEX_URL;
const key = process.env.CONVEX_ADMIN_KEY;

if (step === 'fail') {
  console.log('[hook] failing on purpose');
  process.exit(3);
}
if (!url || !key) {
  console.log('[hook] CONVEX_URL or CONVEX_ADMIN_KEY is missing');
  process.exit(2);
}
const res = await fetch(`${url}/api/query`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Convex ${key}` },
  body: JSON.stringify({ path: '_system/cli/queryEnvironmentVariables:get', format: 'json', args: { name: 'CONVEX_RELEASE_VERSION' } }),
});
const r = await res.json();
if (r.status !== 'success') {
  console.log(`[hook] ${step}: reading the deployment failed: ${r.errorMessage}`);
  process.exit(1);
}
console.log(`[hook] ${step} at ${url}: recorded version ${r.value?.value ?? 'none'}`);
