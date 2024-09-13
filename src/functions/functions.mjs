import ConcurrencyLimitedFetch from './ConcurrencyLimitedFetch.mjs';

const COMPLETION_ENTITY_KIND = 'openai-excel-functions:chat-completion';
const EMPTY_OR_ZERO = 0;

const fetcher = new ConcurrencyLimitedFetch();

CustomFunctions.associate('openai', ChatComplete);

export async function ChatComplete(system_message = ['system', 'You are a helpful assistant.'], messages, model, temperature, apiKey, invocation) {
  // Handle messages as either a single cell or a range of cells
  if (!Array.isArray(messages[0])) {
    messages = [[messages]];
  }

  // Flatten the matrix of messages into a single array if it's a matrix of cell values
  const formattedMessages = messages.map((messageRow) => {
    if (Array.isArray(messageRow)) {
      return messageRow.map(cell => ['user', cell]);
    }
    return ['user', messageRow];
  }).flat();

  // Add the system message to the beginning of the conversation
  formattedMessages.unshift(system_message);

  // Validate apiKey
  if (apiKey == null || apiKey === EMPTY_OR_ZERO) {
    throw new CustomFunctions.Error(
      CustomFunctions.ErrorCode.invalidValue,
      'API_KEY is required',
    );
  }

  try {
    // Create the request body with model and temperature included
    const requestBody = {
      model: model,
      temperature: temperature,
      messages: formattedMessages
        .filter(([role]) => role !== EMPTY_OR_ZERO)
        .map(([role, content]) => ({ role, content })),
    };

    const abortController = new AbortController();
    invocation.onCanceled = () => abortController.abort();

    const response = await fetcher.fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (!response.ok && !response.headers.get('Content-Type').startsWith('application/json')) {
      throw Error(`API error: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();

    if (json.error != null) {
      throw Error(`API error: ${json.error.message}`);
    }

    return {
      type: Excel.CellValueType.entity,
      text: json.choices[0].message.content,
      properties: {
        // These are accessible using formulas. Prefix any that are only for
        // this addin's use, or only for display use, with _.

        _entityKind: COMPLETION_ENTITY_KIND,

        // For visibility of newlines without needing to use cell text wrap.
        lines:
          json.choices.length === 1
            ? json.choices[0].message.content.split('\n')
            : json.choices.map((choice) => choice.message.content.split('\n')),

        requestBody: toEntityProperty(requestBody),
        response: toEntityProperty(json),
      },
      basicType: Excel.RangeValueType.error,
      basicValue: '#VALUE!',
    };
  } catch (e) {
    throw new CustomFunctions.Error(
      CustomFunctions.ErrorCode.notAvailable,
      e.message,
    );
  }
}

CustomFunctions.associate('COST', cost);

export function cost(completionsMatrix, pricesMatrix) {
  const allPrices = Object.fromEntries(
    pricesMatrix.map((row) => [row[0], { input: row[1], output: row[2] }]),
  );

  return completionsMatrix.map((row) =>
    row.map((cell) => {
      if (cell === EMPTY_OR_ZERO) {
        return 0;
      } else {
        validateIsCompletion(cell);
      }

      const model = cell.properties.response.properties.model.basicValue;
      const usage = cell.properties.response.properties.usage.properties;
      const modelPrices = allPrices[model];

      if (!modelPrices) {
        throw new CustomFunctions.Error(
          CustomFunctions.ErrorCode.invalidValue,
          `No prices specified for model ${model}`,
        );
      }

      return (
        (usage.prompt_tokens.basicValue / 1000) * modelPrices.input +
        (usage.completion_tokens.basicValue / 1000) * modelPrices.output
      );
    }),
  );
}

function toEntityProperty(value) {
  if (value === null) {
    // There is no concept of null in Excel's data model.
    return '';
  } else if (typeof value !== 'object') {
    return value;
  } else if (Array.isArray(value)) {
    return {
      // An array in this context is really a matrix.
      type: Excel.CellValueType.array,
      elements: [value.map((element) => toEntityProperty(element))],
    };
  } else {
    return {
      type: Excel.CellValueType.entity,
      text: 'Entity...',
      properties: mapObject(value, toEntityProperty),
    };
  }
}

function validateIsCompletion(anyTypedParameter) {
  if (
    !(
      anyTypedParameter.type === Excel.CellValueType.entity &&
      anyTypedParameter.properties._entityKind.basicValue ===
        COMPLETION_ENTITY_KIND
    )
  ) {
    throw new CustomFunctions.Error(
      CustomFunctions.ErrorCode.invalidValue,
      'Completion in parameter value is not a OPENAI() completion',
    );
  }
}

function mapObject(object, callback) {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key, callback(value)]),
  );
}
