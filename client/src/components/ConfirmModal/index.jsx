import React, { useCallback, useEffect, useId, useRef } from 'react';

import { Button, Modal, ModalBody, ModalFooter, ModalHeader } from 'reactstrap';

import graphQLErrors from '../../utils/graphql-errors.js';

// Asks before something that cannot be taken back, such as deleting an export ban list. The title
// asks the question, the body says what will happen, and only the confirm button, which names the
// action, goes ahead. Cancel has focus when it opens, so pressing Enter again, or holding it down,
// cancels rather than confirms. Escape and a click outside it cancel too, and focus then goes back to
// the button that opened it. While the action runs (busy), it stays open and its buttons do nothing.
// If the action fails, its error shows here, focus goes to Cancel, and it can be tried again.
export default function ConfirmModal(props) {
  const { isOpen, busy, error, onCancel, onConfirm } = props;
  const titleID = useId();
  const descriptionID = useId();
  const cancelButton = useRef(null);

  // The web server's messages, or the error's own for a request that got no answer.
  const messages = error ? graphQLErrors(error).map(({ message }) => message) : [];
  if (error && messages.length === 0) messages.push(error.message);

  // Once a failed action has finished, focus goes to Cancel, so pressing Enter again does not try
  // again by accident.
  const failed = isOpen && !busy && messages.length > 0;
  useEffect(() => {
    if (failed) cancelButton.current?.focus();
  }, [failed]);

  // reactstrap's Modal has no prop for a description, so the body is named as the dialog's once it
  // is shown, and screen readers read what will happen as it opens.
  const describe = useCallback((node) => {
    node?.closest('.modal')?.setAttribute('aria-describedby', node.id);
  }, []);

  const cancel = () => {
    if (!busy) onCancel();
  };
  const confirm = () => {
    if (!busy) onConfirm();
  };

  return (
    <Modal
      className="modal-dialog-centered"
      isOpen={isOpen}
      toggle={cancel}
      role="alertdialog"
      labelledBy={titleID}
      // Cancel takes focus itself (autoFocus below), rather than the dialog as a whole.
      autoFocus={false}
      // Once the action has worked, the button that opened the dialog may be gone, so the page moves
      // focus instead.
      returnFocusAfterClose={props.returnFocus !== false}
    >
      <ModalHeader>
        <span id={titleID}>{props.title}</span>
      </ModalHeader>
      <ModalBody>
        <div id={descriptionID} ref={describe}>
          {props.children}
        </div>
        {messages.length > 0 && (
          <div className="alert alert-danger mt-3 mb-0" role="alert">
            {messages.map((message, key) => (
              <p key={key} className="mb-0">
                {message}
              </p>
            ))}
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button
          innerRef={cancelButton}
          color="secondary"
          type="button"
          autoFocus
          disabled={busy}
          onClick={cancel}
        >
          Cancel
        </Button>
        {/* Only marked disabled while the action runs, as a disabled button would lose focus. */}
        <Button
          className={busy ? 'disabled' : undefined}
          color="danger"
          type="button"
          aria-disabled={busy}
          onClick={confirm}
        >
          {busy ? props.busyLabel : props.confirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
