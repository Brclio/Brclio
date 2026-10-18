import * as updateProxy from './update-proxy.js';

// Register only implemented modules. Authentication and the admin shell stay shared.
export const modules = Object.freeze([updateProxy]);
