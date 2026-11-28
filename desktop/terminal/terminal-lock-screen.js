'use strict';
const pin = document.getElementById('lock-pin'), touch = document.getElementById('touch-id');
const status = document.querySelector('[role=status]');
let pending = false;
async function unlock(method) {
  if (pending) return;
  pending = true; status.textContent = '';
  const value = pin.value; pin.value = '';
  try {await window.brclioUnlock.unlock(method,value);}
  catch (error) {status.textContent = error.message; pin.focus();}
  finally {pending = false;}
}
document.querySelector('form').onsubmit = event => {event.preventDefault(); unlock('pin');};
touch.onclick = () => unlock('biometric');
touch.textContent = '使用 ' + window.brclioUnlock.systemVerification + ' 解锁';
window.brclioUnlock.biometric().then(available => {touch.hidden = !available;}).catch(() => {});
