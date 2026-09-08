/** Awaits a rejected operation so tests can inspect the error without matcher magic. */
export async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  throw new Error("Expected the operation to reject.");
}
