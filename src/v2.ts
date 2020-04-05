import prettier from 'prettier';
import { OpenAPI2, OpenAPI2SchemaObject, PropertyMapper } from './types/index';
import {
  escape,
  fromEntries,
  isArrayNodeV2,
  isObjNodeV2,
  isRootNodeV2,
  isSchemaObjV2,
  makeOptional,
  tsArrayOf,
  tsIntersectionOf,
  tsUnionOf,
  unescape,
} from './utils';

export const PRETTIER_OPTIONS: prettier.Options = { parser: 'typescript', singleQuote: true };

export const PRIMITIVES: { [key: string]: 'boolean' | 'string' | 'number' } = {
  // boolean types
  boolean: 'boolean',

  // string types
  binary: 'string',
  byte: 'string',
  date: 'string',
  dateTime: 'string',
  password: 'string',
  string: 'string',

  // number types
  double: 'number',
  float: 'number',
  integer: 'number',
  number: 'number',
};

export const WARNING_MESSAGE = `/**
 * This file was auto-generated by swagger-to-ts.
 * Do not make direct changes to the file.
 */
`;

export default function generateTypesV2(schema: OpenAPI2, propertyMapper?: PropertyMapper): string {
  if (!schema.definitions) {
    throw new Error(
      `🧐 Definitions Object missing from schema https://swagger.io/specification/v2/#definitions-object`
    );
  }

  // 1st pass: expand $refs first to reduce lookups & prevent circular refs
  const expandedRefs = JSON.parse(
    JSON.stringify(schema.definitions),
    (_, node) =>
      node && node['$ref']
        ? escape(`definitions['${node.$ref.replace('#/definitions/', '')}']`) // important: use single-quotes here for JSON (you can always change w/ Prettier at the end)
        : node // return by default
  );

  // 2nd pass: propertyMapper
  let propertyMapped = expandedRefs;
  if (typeof propertyMapper === 'function') {
    propertyMapped = JSON.parse(JSON.stringify(expandedRefs), (_, node: OpenAPI2SchemaObject) => {
      // if no properties, skip
      if (!isObjNodeV2(node) || !node.properties) {
        return node;
      }

      // map over properties, transforming if needed
      node.properties = fromEntries(
        Object.entries(node.properties).map(([key, val]) => {
          // if $ref, skip
          if (val.$ref) {
            return [key, val];
          }

          const schemaObject = val as OpenAPI2SchemaObject;

          const property = propertyMapper(schemaObject, {
            interfaceType: schemaObject.type as string,
            optional: !Array.isArray(node.required) || node.required.includes(key),
            description: schemaObject.description,
          });

          // update requirements
          if (property.optional) {
            if (Array.isArray(node.required)) {
              node.required = node.required.filter((r) => r !== key);
            }
          } else {
            node.required = [...(node.required || []), key];
          }

          // transform node from mapper
          return [key, { ...val, type: property.interfaceType, description: property.description }];
        })
      ) as OpenAPI2SchemaObject['properties'];

      return node; // return by default
    });
  }

  // 4th pass: primitives
  const primitives = JSON.parse(JSON.stringify(propertyMapped), (_, node: OpenAPI2SchemaObject) => {
    if (node.type && PRIMITIVES[node.type]) {
      // prepend comment to each item
      return escape(
        node.enum ? tsUnionOf(node.enum.map((item) => `'${item}'`)) : PRIMITIVES[node.type]
      );
    }
    return node; // return by default
  });

  // 5th pass: objects & arrays
  const objectsAndArrays = JSON.parse(JSON.stringify(primitives), (_, node) => {
    // object
    if (isObjNodeV2(node)) {
      const allProperties: any[] = [
        ...(node.allOf || []),
        ...Object.values({ ...(node.properties || {}) }),
      ];

      // handle no properties
      if (
        (!node.properties || !Object.keys(node.properties).length) &&
        (!node.allOf || !node.allOf.length) &&
        !node.additionalProperties
      ) {
        return escape(`{[key: string]: any}`);
      }

      // skip if not root node
      if (!isRootNodeV2(allProperties)) {
        return node;
      }

      // unescape properties if some have been transformed already for nested objects
      const properties = makeOptional(
        fromEntries(
          Object.entries((node.properties as OpenAPI2SchemaObject['properties']) || {}).map(
            ([key, val]) => {
              if (typeof val === 'string') {
                // try and parse as JSON to remove bad string escapes; otherwise, escape normally
                try {
                  return [key, JSON.parse(val)];
                } catch (err) {
                  return [key, escape(unescape(val))];
                }
              }
              return [key, val];
            }
          )
        ),
        node.required
      );

      // if additional properties, add to end of properties
      if (node.additionalProperties) {
        const addlType =
          typeof node.additionalProperties === 'string' &&
          PRIMITIVES[unescape(node.additionalProperties)];
        properties[escape('[key: string]')] = escape(addlType || 'any');
      }

      return tsIntersectionOf([
        // append allOf first
        ...(node.allOf
          ? node.allOf.map((item: any) =>
              isSchemaObjV2(item) ? JSON.stringify(makeOptional(item, node.required)) : item
            )
          : []),
        // then properties + additionalProperties
        ...(Object.keys(properties).length ? [JSON.stringify(properties)] : []),
      ]);
    }

    // arrays
    if (isArrayNodeV2(node) && typeof node.items === 'string') {
      return escape(tsArrayOf(node.items));
    }

    return node; // return by default
  });

  return prettier.format(
    `${WARNING_MESSAGE}\n\n\nexport interface definitions {
      ${unescape(
        Object.entries(objectsAndArrays)
          .map(([key, val]) => {
            return `${JSON.stringify(key)}: ${val}`;
          })
          .join(';\n')
      )}
    }`,
    PRETTIER_OPTIONS
  );
}
