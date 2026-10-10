import graphql from 'graphql';
import { getDirective, MapperKind, mapSchema } from '@graphql-tools/utils';

const { defaultFieldResolver } = graphql;

// Fields marked @systemAdminOnly resolve to null unless the request comes from a system admin.
export default function systemAdminOnly(schema) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_FIELD]: (field) => {
      if (!getDirective(schema, field, 'systemAdminOnly')?.[0]) return field;

      const { resolve = defaultFieldResolver } = field;

      field.resolve = async function (parent, args, context, info) {
        if (context.isSystemAdmin) return resolve.apply(this, [parent, args, context, info]);
        return null;
      };

      return field;
    }
  });
}
