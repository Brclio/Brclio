import {modules} from './modules/index.js';
import {overview as updateProxyOverview} from './modules/update-proxy.js';

export const service = Object.freeze({
  id: 'brclio-client-services',
  name: 'Brclio客户端服务'
});

export async function adminOverview(env, session, dependencies) {
  return {
    service,
    account: {email: session.email},
    modules: modules.map(module => module.metadata),
    updates: await updateProxyOverview(env, dependencies),
    csrf: session.csrf
  };
}
