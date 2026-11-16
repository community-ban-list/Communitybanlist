import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button, Modal, ModalBody, ModalFooter, ModalHeader } from 'reactstrap';

import graphQLErrors from '../../utils/graphql-errors.js';

// How long, in milliseconds, the confirm button waits once the dialog has opened before it takes a
// press. The dialog is in the page from the press that opens it, but only shows after reactstrap's
// 300 ms opening step, and then slides into place, so the second press of a quick double click or
// double tap could otherwise confirm before the dialog can be seen.
const READY_AFTER = 500;

// Asks before something that cannot be taken back, such as deleting an export ban list. The title
// asks the question, the body says what will happen, and only the confirm button, which names the
// action, goes ahead. Cancel has focus when it opens, so pressing Enter again, or holding it down,
// cancels rather than confirms. Escape and a click outside it cancel too, and focus then goes back to
// the button that opened it. The confirm button only takes a press once the dialog has been open
// for a moment (see READY_AFTER), and until then a click outside it does not close it either. While
// the action runs (busy), it stays open and its buttons do nothing. If the action fails, its error
// shows here, focus goes to Cancel, and it can be tried again.
export default function ConfirmModal(props) {
  const { isOpen, busy, error, onCancel, onConfirm } = props;
  const titleID = useId();
  const descriptionID = useId();
  const cancelButton = useRef(null);

  // reactstrap calls onOpened once the dialog has opened, and onClosed once it has gone. Each time it
  // opens, the confirm button waits again.
  const [ready, setReady] = useState(false);
  const readyTimer = useRef(null);
  const opened = () => {
    clearTimeout(readyTimer.current);
    readyTimer.current = setTimeout(() => setReady(true), READY_AFTER);
  };
  const closed = () => {
    clearTimeout(readyTimer.current);
    setReady(false);
  };
  useEffect(() => () => clearTimeout(readyTimer.current), []);

  // The errors to show, as the site's forms show them (utils/graphql-errors.js): the web server's
  // messages, or, for a request that got no answer, that the server could not be reached and the
  // action may still have been done.
  const messages = graphQLErrors(error).map(({ message }) => message);

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

  // It confirms only while it is open and ready, and not while the action runs, so once cancelled it
  // cannot confirm as it closes.
  const canConfirm = isOpen && ready && !busy;
  const cancel = () => {
    if (!busy) onCancel();
  };
  const confirm = () => {
    if (canConfirm) onConfirm();
  };

  return (
    <Modal
      className="modal-dialog-centered"
      isOpen={isOpen}
      toggle={cancel}
      role="alertdialog"
      labelledBy={titleID}
      // A click outside it only closes it once it is ready, as the second press of a double click
      // can land there as it opens. Escape always closes it.
      backdrop={ready ? true : 'static'}
      onOpened={opened}
      onClosed={closed}
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
        {/* Only marked disabled until it can confirm, as a disabled button would lose focus while
            the action runs. */}
        <Button
          className={canConfirm ? undefined : 'disabled'}
          color="danger"
          type="button"
          aria-disabled={!canConfirm}
          onClick={confirm}
        >
          {busy ? props.busyLabel : props.confirmLabel}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
