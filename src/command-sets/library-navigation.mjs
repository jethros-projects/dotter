import { DotLibrary } from '../library.mjs';
import { DotError } from '../errors.mjs';
export const createClient = client => {
  const library = new DotLibrary(client);
  const target = (value, root) => {
    if (root && value !== undefined || !root && value === undefined) throw new DotError('INVALID_ARGUMENT','Choose a directory ID or --root.');
    return root ? null : value;
  };
  return {
    move: ({fileId,directoryId,root,signal}) => library.move({fileId,directoryId:target(directoryId,root),signal}),
    moveDirectory: ({directoryId,parentDirectoryId,root,signal}) => library.moveDirectory({directoryId,parentDirectoryId:target(parentDirectoryId,root),signal}),
    directoryPath: ({directoryId,root,signal}) => {if(root&&directoryId!==undefined)throw new DotError('INVALID_ARGUMENT','Choose a directory ID or --root.');return library.directoryPath({directoryId:directoryId??null,signal});}
  };
};
const string=target=>({target,type:'string'}),boolean=target=>({target,type:'boolean'});
export const commands = {
 'library move':{method:'move',positionals:['fileId'],flags:{'--directory':string('directoryId'),'--root':boolean('root')},description:'Move an account file into a folder or to the Library root.'},
 'library move-directory':{method:'moveDirectory',positionals:['directoryId'],flags:{'--parent':string('parentDirectoryId'),'--root':boolean('root')},description:'Move a folder into a parent or to the Library root.'},
 'library directory-path':{method:'directoryPath',positionals:['directoryId'],minPositionals:0,flags:{'--root':boolean('root')},description:'Read a folder path or the Library root path.'}
};
