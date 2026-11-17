import './style.css';
import { applyStaticI18n, t } from './i18n';

// Boot: check that the browser can draw 3D before loading the app (audit OV-006).
// Without WebGL the readable page and its links stay usable and the visitor gets an explanation.

function hasWebGL(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

function showNoWebGL(reason: string) {
  document.body.classList.add('no-webgl');
  document.querySelectorAll<HTMLButtonElement>('[data-action],[data-tool],[data-gizmo],[data-menu],[data-example],[data-m]').forEach((b) => {
    b.disabled = true;
    b.setAttribute('aria-disabled', 'true');
  });
  const host = document.querySelector('.welcome-inner') || document.body;
  const box = document.createElement('div');
  box.className = 'capability-note';
  box.setAttribute('role', 'alert');
  box.innerHTML = `<strong>${t('3D graphics are not available in this browser')}</strong>
    <p>${t('OMNIVIEWER needs WebGL to show 3D models. It may be turned off, blocked by a policy, or not supported by this graphics driver.')}</p>
    <ul>
      <li>${t('Try an up-to-date Chrome, Edge, Firefox or Safari.')}</li>
      <li>${t('Turn on hardware acceleration in your browser settings, then reload.')}</li>
      <li>${t('On a work computer, graphics may be disabled by your administrator.')}</li>
    </ul>
    <p><button class="btn-solid" id="retryWebgl">${t('Try again')}</button></p>
    <p class="note">${reason}</p>`;
  host.prepend(box);
  document.getElementById('retryWebgl')?.addEventListener('click', () => location.reload());
}

applyStaticI18n();
if (!hasWebGL()) showNoWebGL(t('No WebGL context could be created.'));
else import('./app').catch((e) => { console.error(e); showNoWebGL(String(e?.message || e)); });
