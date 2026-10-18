import { DotWidgets } from '../widgets.mjs';
// Legacy internal construction only; widget commands are no longer registered.
export const createClient = client => new DotWidgets(client);
export const commands = {};
