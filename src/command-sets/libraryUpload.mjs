import { LibraryUpload } from '../library-upload.mjs';
export const createClient=client=>new LibraryUpload(client);
const scope={'--account':{target:'expectedAccountId',type:'string'},'--state-file':{target:'stateFile',type:'path'}};
const required=['expectedAccountId','stateFile'];
export const commands={
  'library upload':{method:'upload',positionals:['file'],flags:{...scope,'--directory':{target:'directoryId',type:'string'},'--mime':{target:'mimeType',type:'string'},'--resume-parts':{target:'resumeParts',type:'boolean'}},required,description:'Upload up to512 MiB to Library with private recovery state; folder destinations stage at root before a verified move. Explicit --resume-parts repeats only unchanged uncommitted blocks; uncertain commit, processing or move is never replayed.'},
  'library upload-status':{method:'status',positionals:[],flags:scope,required,description:'Inspect a private Library upload journal without replaying a request.'},
  'library upload-reconcile':{method:'reconcile',positionals:[],flags:scope,required,description:'Read back the exact uploaded file mapping after interruption; never retry an uncertain write.'}
};
