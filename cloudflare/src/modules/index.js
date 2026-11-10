import * as updateProxy from './update-proxy.js';
import * as feedback from './feedback.js';

// Register only implemented modules. Authentication and the admin shell stay shared.
export const modules = Object.freeze([updateProxy, feedback]);
