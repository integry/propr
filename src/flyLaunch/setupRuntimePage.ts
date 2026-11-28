/**
 * The agent runtime step of the Fly dashboard launch wizard (#3827): one
 * short form at a time. Sprites (the default) asks for one token and shows how
 * to scope it to this instance; Fly Machines comes prefilled (agent app, the
 * published agent image, Machines at once) and stays collapsed until chosen.
 * Without :has() support every option's fields are shown.
 */
import { DEFAULT_AGENT_IMAGE, defaultAgentMachines, FREE_PLAN_MACHINES, SPRITES_TOKENS_URL } from './runtimeValidation.js';
import { escapeHtml, externalLink, renderPage, why, type GithubPath, type InstanceInfo } from './setupLayout.js';

/** Non-secret values to keep after a failed check; tokens are never rendered back. */
export interface RuntimeFormValues {
    runtime?: string;
    flyApp?: string;
    flyImage?: string;
    flyMachinesMax?: string;
    /** Which path's step list to show (not a form value). */
    path?: GithubPath;
}

export interface RuntimePageContext {
    /** The signed-in administrator. */
    admin: string;
    controlPlaneApp: string;
    /** The name prefix of this instance's Sprites (spritesNamePrefix). */
    spritesPrefix: string;
    /** Machines of this app, when known (countAppMachines). */
    controlPlaneMachines?: number;
}

const FLY_DASHBOARD_URL = 'https://fly.io/dashboard/personal';
const SPRITES_DASHBOARD_URL = 'https://fly.io/dashboard/personal/sprites';
const REMOVING_DOCS_URL = 'https://docs.propr.dev/docs/tutorials/setup-fly#removing-propr';

function option(id: string, checked: boolean, text: { title: string; description: string; panel: string }): string {
    const { title, description, panel } = text;
    return `<div class="option"><label class="choice"><input type="radio" name="runtime" value="${id}"${checked ? ' checked' : ''}> <span>${title}<br><span class="desc">${description}</span></span></label>${panel ? `<div class="panel">${panel}</div>` : ''}</div>`;
}

function spritesPanel(prefix: string): string {
    return `<label for="spritesToken">Sprites token</label><input id="spritesToken" name="spritesToken" type="password" autocomplete="off">
<p class="hint">${externalLink(SPRITES_TOKENS_URL, 'Create Token')} on Fly's Sprites tokens page (personal org; for another org, switch org there).</p>
<p class="hint">Recommended scope:</p>
<ol class="scope"><li>Name prefix: <code>${escapeHtml(prefix)}</code></li><li>Max Sprites: 1 on the Free Plan.</li><li>Expiry: optional.</li></ol>
${why(`ProPR names every Sprite of this instance <code>${escapeHtml(prefix)}&lt;id&gt;</code> and runs one at a time, so a token scoped this way can reach only this instance's Sprites. The check lists Sprites under that prefix.`)}
${why(`The Sprites belong to the Sprites organization, not to the Fly app, so deleting the app leaves them behind, using the organization's Sprite slots. Before you delete the app, open <strong>Settings → Maintenance → Agent runtime</strong> and select <strong>Remove all Sprites of this instance</strong>, or delete the Sprites named <code>${escapeHtml(prefix)}*</code> in the ${externalLink(SPRITES_DASHBOARD_URL, 'Sprites dashboard')}. ${externalLink(REMOVING_DOCS_URL, 'Removing ProPR')}`, 'Removing ProPR')}`;
}

function flyMachinesPanel(agentApp: string, values: RuntimeFormValues, machinesDefault: number, controlPlaneMachines: number | undefined): string {
    const value = (field: string | undefined): string => (field ? ` value="${escapeHtml(field)}"` : '');
    const app = values.flyApp || agentApp;
    const span = `<span data-agent-app>${escapeHtml(app)}</span>`;
    const own = controlPlaneMachines ?? 1;
    return `<label for="flyApp">Agent app</label><input id="flyApp" name="flyApp" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(agentApp)}"${value(app)}>
<p class="hint">A separate app for agent Machines only; create it and its deploy token with:</p>
<div class="cmd"><pre>fly apps create ${span} &amp;&amp; fly tokens create deploy --app ${span} --expiry 8760h</pre></div>
<p class="hint">Or in the dashboard: ${externalLink(FLY_DASHBOARD_URL, 'Fly dashboard')} → new app, then the app's <strong>Tokens</strong> → <strong>Create deploy token</strong>.</p>
<label for="flyToken">Deploy token for the agent app</label><input id="flyToken" name="flyToken" type="password" autocomplete="off">
<p class="hint">The token the command printed; never an organization or personal token.</p>
<label for="flyImage">Agent image</label><input id="flyImage" name="flyImage" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(DEFAULT_AGENT_IMAGE)}"${value(values.flyImage || DEFAULT_AGENT_IMAGE)}>
<p class="hint">The published agent image for this ProPR version, pulled from Docker Hub.</p>
<label for="flyMachinesMax">Agent Machines at once</label><input id="flyMachinesMax" name="flyMachinesMax" type="text" inputmode="numeric"${value(values.flyMachinesMax || String(machinesDefault))}>
<p class="hint">Free Plan: ${FREE_PLAN_MACHINES} Machines, minus this app's ${own}.</p>
${why(`The Free Plan allows ${FREE_PLAN_MACHINES} Machines per organization, stopped ones included. This app has ${own}${controlPlaneMachines === undefined ? ' (a dashboard launch creates one)' : ' running'}; lower the number if other apps in the organization have Machines too.`)}
<details class="advanced"><summary>Advanced: build your own agent image</summary><div>
<p>Build <code>Dockerfile.agent</code> into the agent app, for example with the fork's <strong>Build Fly agent image</strong> workflow (Actions tab), and paste the <code>registry.fly.io/${span}@sha256:…</code> digest it prints.</p>
<p class="hint">An image in the agent app's own registry also lets ProPR preinstall agent runtime packages once; with a Docker Hub image they install at each Machine start.</p></div></details>`;
}

export function runtimePage(instance: InstanceInfo, context: RuntimePageContext, error?: string, values: RuntimeFormValues = {}): string {
    const agentApp = `${context.controlPlaneApp || 'propr'}-agents`;
    const selected = ['sprites', 'fly-machines', 'none'].includes(values.runtime ?? '') ? values.runtime : 'sprites';
    const machinesDefault = defaultAgentMachines(context.controlPlaneMachines);
    return renderPage(instance, {
        title: 'Choose where agents run',
        step: 'runtime',
        path: values.path,
        error,
        body: `<p>Signed in as <strong>${escapeHtml(context.admin)}</strong>. Agents run outside this Machine; pick where.</p>
<form method="post" action="/setup/runtime"><fieldset class="runtimes"><legend>Agent runtime</legend>
${option('sprites', selected === 'sprites', {
        title: 'Sprites <span class="badge">Recommended</span>', description: 'Fly\'s sandboxes: one token, nothing to build.', panel: spritesPanel(context.spritesPrefix) })}
${option('fly-machines', selected === 'fly-machines', {
        title: 'Fly Machines', description: 'Agent Machines in a separate Fly app.', panel: flyMachinesPanel(agentApp, values, machinesDefault, context.controlPlaneMachines) })}
${option('none', selected === 'none', {
        title: 'Not yet', description: 'Start the control plane only; add a runtime later.',
        panel: '<p class="hint">Agent runs fail with a clear error until you add <code>SPRITES_TOKEN</code> or the <code>PROPR_FLY_*</code> settings as Fly secrets.</p>' })}
</fieldset>
<p class="hint">Each choice is checked before it is saved.</p>
<button type="submit" data-busy="Checking…">Check and save</button></form>`,
    });
}
