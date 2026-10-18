import { DotMail } from '../mail.mjs';
export const createClient = client => new DotMail(client);
const account = { '--account': { target: 'expectedAccountId', type: 'string' } };
export const commands = {
  'mail accounts': { method: 'accounts', positionals: [], flags: account, description: 'List connected Gmail, Outlook and contacts account readiness.' },
  'mail send': { method: 'send', positionals: [], flags: { ...account,
    '--provider': { target: 'provider', type: 'string' }, '--link': { target: 'linkId', type: 'string' },
    '--to': { target: 'to', type: 'list' }, '--cc': { target: 'cc', type: 'list' }, '--bcc': { target: 'bcc', type: 'list' },
    '--subject': { target: 'subject', type: 'string' }, '--body-file': { target: 'body', type: 'textFile' }, '--send-id': { target: 'sendId', type: 'string' },
    '--reply': { target: 'replyTo', type: 'json' }, '--source-id': { target: 'sourceId', type: 'string' }, '--source-type': { target: 'sourceType', type: 'string' }
  }, specFields: ['provider', 'linkId', 'to', 'cc', 'bcc', 'subject', 'body', 'sendId', 'replyTo', 'sourceId', 'sourceType'], required: ['provider', 'linkId', 'subject', 'body'], key: 'sendId', description: 'Send mail once through an explicitly selected authorized Gmail or Outlook account.' },
  'mail status': { method: 'status', positionals: ['sendId'], flags: account, description: 'Reconcile the original mail send ID without resending.' },
  'mail undo': { method: 'undo', positionals: ['sendId'], flags: { ...account, '--expires': { target: 'unsendExpiresAt', type: 'string' } }, required: ['unsendExpiresAt'], description: 'Request undo inside the original send receipt’s undo deadline.' },
  'mail contacts': { method: 'contacts', positionals: ['query'], flags: { ...account, '--link': { target: 'linkId', type: 'string' } }, required: ['linkId'], description: 'Search recipient suggestions through an explicitly selected contacts link.' }
};
