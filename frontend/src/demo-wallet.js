async function post(path, body = {}) {
  const response = await fetch(`/__demo/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error?.message || data.error || "Local demo request failed.");
    Object.assign(error, { code: data.error?.code, data: data.error?.data });
    throw error;
  }
  return data;
}

export function localWallet(address) {
  return { request: async ({ method, params = [] }) => {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
    if (method === "eth_sendTransaction" && params[0]?.from?.toLowerCase() !== address.toLowerCase()) throw new Error("Demo wallet changed. Reconnect.");
    return (await post("rpc", { method, params })).result;
  } };
}

export function mountDemoUI({ enabled, document, run, onAccount, onExit, getCampaign, reloadCampaign, navigate }) {
  const $ = (id) => document.getElementById(id);
  if (!enabled) return;
  $("demo-section").hidden = false;
  let info;
  $("demo-start").onclick = () => run(async () => {
    $("demo-status").textContent = "Preparing a local blockchain and tokenized coffee business...";
    info = await post("start");
    $("demo-account").replaceChildren();
    for (const account of info.accounts) {
      const option = document.createElement("option"); option.value = account.address; option.textContent = account.name;
      $("demo-account").append(option);
    }
    $("demo-account").value = info.accounts[0].address;
    $("demo-controls").hidden = false;
    $("demo-start").hidden = true;
    await selectAccount(info.accounts[0].address);
  });
  async function selectAccount(address) {
    $("demo-account-address").textContent = address;
    await onAccount(localWallet(address), info);
    $("demo-status").textContent = "Local demo active. Switch roles here to test investor contributions and issuer settlement. ETH is simulated.";
    navigate("funding");
  }
  $("demo-account").onchange = () => run(() => selectAccount($("demo-account").value));
  $("demo-deadline").onclick = () => run(async () => {
    const address = getCampaign();
    if (!address) throw new Error("Load a demo campaign in Funding before advancing its deadline.");
    await post("advance", { address });
    await reloadCampaign();
    $("demo-status").textContent = "Local blockchain advanced past the deadline. Finalize the underfunded campaign to enable refunds.";
    navigate("funding");
  });
  $("demo-exit").onclick = () => run(async () => {
    await onExit();
    $("demo-controls").hidden = true;
    $("demo-start").hidden = false;
    $("demo-status").textContent = "Demo disconnected. Your browser wallet is available again.";
    navigate("wallet");
  });
}
