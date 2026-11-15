// Minimal constructor for unit tests; deployed tests exercise the real runtime.
export class DurableObject<E> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: E,
  ) {}
}
