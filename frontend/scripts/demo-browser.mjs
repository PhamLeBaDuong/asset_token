import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

// Run against an already running local Vite server and headless browser CDP port.
const base = process.env.DEMO_URL || "http://127.0.0.1:5174";
const debug = process.env.DEMO_BROWSER_URL || "http://127.0.0.1:9223";
const targets = await (await fetch(`${debug}/json/list`)).json();
const target = targets.find((entry) => entry.type === "page");
if (!target) throw new Error("No browser page is available for the demo.");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
let nextId = 0;
const pending = new Map(), errors = [], results = [];
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text + ": " + (message.params.exceptionDetails.exception?.description || ""));
  if (!message.id) return;
  const handlers = pending.get(message.id);
  if (!handlers) return;
  pending.delete(message.id);
  clearTimeout(handlers.timeout);
  message.error ? handlers.reject(Error(message.error.message)) : handlers.resolve(message.result);
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(`Browser command timed out: ${method}`)); }, 60000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function wait(expression) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`UI wait timed out: ${expression}. ${await evaluate("document.getElementById('status')?.textContent")}`);
}
async function action(expression) {
  await evaluate(expression);
  await wait("!document.getElementById('connect').disabled");
}
async function click(id) { await action(`document.getElementById(${JSON.stringify(id)}).click()`); }
async function set(id, value) { await evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}`); }
async function account(index) {
  await action(`document.getElementById('demo-account').selectedIndex=${index}; document.getElementById('demo-account').dispatchEvent(new Event('change'))`);
}
async function state(expected) {
  assert.equal(await evaluate("document.getElementById('campaign-state').textContent"), expected,
    await evaluate("document.getElementById('status').textContent"));
}
function record(message) { results.push(message); console.log(message); }
const directory = new URL("../../docs/demo/", import.meta.url);
mkdirSync(directory, { recursive: true });
async function screenshot(name) {
  const image = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(new URL(name, directory), Buffer.from(image.data, "base64"));
}

try {
  await command("Runtime.enable");
  await command("Page.enable");
  await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
  await command("Page.navigate", { url: `${base}/#wallet` });
  await wait("!!document.getElementById('demo-start')?.onclick");
  const original = await evaluate("({chain:document.getElementById('chain').value,factory:document.getElementById('factory').value})");
  await screenshot("01-wallet.png");
  await click("demo-start");
  await wait("document.getElementById('campaign-role').textContent === 'Issuer workspace'");
  assert.equal(await evaluate("document.getElementById('page-funding').hidden"), false);
  assert.equal(await evaluate("document.querySelectorAll('[data-page]:not([hidden])').length"), 1);
  await screenshot("02-issuer-create.png");
  record("Started local demo, loaded Duong Coffee, and displayed the issuer campaign form.");

  async function create() {
    await set("campaign-goal", "0.01"); await set("campaign-offered", "10000");
    await evaluate(`(async () => {
      const response=await fetch('/__demo/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'eth_getBlockByNumber',params:['latest',false]})});
      const {result}=await response.json(); const date=new Date((Number(BigInt(result.timestamp))+86400)*1000);
      document.getElementById('campaign-deadline').value=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
    })()`);
    await action("document.getElementById('campaign-create-form').requestSubmit()");
    await state("Setup");
    const address = await evaluate("document.getElementById('campaign-address').value");
    await click("campaign-approve"); await click("campaign-activate"); await state("Active");
    return address;
  }
  const successful = await create();
  record(`Created, approved, and activated campaign ${successful}.`);
  await account(1);
  assert.equal(await evaluate("document.getElementById('campaign-role').textContent"), "Investor workspace");
  assert.equal(await evaluate("document.getElementById('campaign-create-form').hidden"), true);
  assert.match(await evaluate("document.getElementById('campaign-issuer-notice').textContent"), /original issuer wallet/);
  await set("campaign-amount", "0.002");
  await screenshot("03-investor-contribute.png");
  for (const [index, amount] of [[1, "0.002"], [2, "0.003"], [3, "0.005"]]) {
    await account(index); await set("campaign-amount", amount);
    await action("document.getElementById('campaign-contribute-form').requestSubmit()");
    record(`Investor ${index} contributed ${amount} ETH using the browser form.`);
  }
  await state("Successful");
  assert.equal(await evaluate("document.getElementById('campaign-progress').value"), 100);
  await account(0); await click("campaign-settle"); await state("Settled");
  for (const [index, tokens] of [[1, 2000], [2, 3000], [3, 5000]]) {
    await account(index);
    const balance = () => evaluate("Array.from(document.querySelectorAll('#result dt')).find(e=>e.textContent==='Your balance').nextElementSibling.textContent");
    const before = parseFloat(await balance());
    await click("campaign-claimTokens");
    assert.equal(parseFloat(await balance()) - before, tokens);
    assert.equal(await evaluate("document.getElementById('campaign-claimTokens').hidden"), true);
    record(`Investor ${index} claimed ${tokens} DCOF; repeat-claim button is hidden.`);
  }
  await screenshot("04-success-settled.png");

  await account(0);
  const failed = await create();
  for (const [index, amount] of [[1, "0.002"], [2, "0.0015"]]) {
    await account(index); await set("campaign-amount", amount);
    await action("document.getElementById('campaign-contribute-form').requestSubmit()");
  }
  await click("demo-deadline"); await click("campaign-finalize"); await state("Failed");
  await screenshot("05-failed-refund.png");
  record(`Second campaign ${failed} raised 0.0035 / 0.01 ETH and finalized as Failed after advancing local time.`);
  await account(0); await click("campaign-reclaimFailedTokens");
  for (const index of [1, 2]) {
    await account(index); await click("campaign-claimRefund");
    assert.equal(await evaluate("document.getElementById('campaign-claimRefund').hidden"), true);
    record(`Investor ${index} claimed their refund; repeat-refund button is hidden.`);
  }
  const balance = await evaluate(`(async()=>{const r=await fetch('/__demo/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'eth_getBalance',params:[${JSON.stringify(failed)},'latest']})}); return (await r.json()).result})()`);
  assert.equal(BigInt(balance), 0n);
  record("Failed campaign ETH balance is zero after refunds; issuer recovered all 10,000 reserved tokens.");

  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, "mobile page should not overflow horizontally");
  await screenshot("06-mobile.png");
  await evaluate("document.querySelector('nav a[data-page-link=assets]').click()");
  assert.equal(await evaluate("document.getElementById('page-assets').hidden"), false);
  assert.equal(await evaluate("document.getElementById('page-funding').hidden"), true);
  record("Navigation shows one section at a time, and the mobile layout has no page overflow.");
  await click("demo-exit");
  assert.equal(await evaluate("document.getElementById('demo-controls').hidden"), true);
  assert.equal(await evaluate("document.getElementById('page-wallet').hidden"), false);
  assert.deepEqual(await evaluate("({chain:document.getElementById('chain').value,factory:document.getElementById('factory').value})"), original);
  record("Leaving demo restores the browser-wallet network settings and clears the demo account controls.");
  assert.deepEqual(errors, [], "browser should have no uncaught JavaScript exceptions");
  writeFileSync(new URL("results.json", directory), JSON.stringify({
    ranAt: new Date().toISOString(), network: "Local Hardhat / simulated ETH", successful, failed, results, browserErrors: errors
  }, null, 2) + "\n");
  console.log("Browser demo passed. Screenshots and results saved to docs/demo/.");
} finally { ws.close(); }
