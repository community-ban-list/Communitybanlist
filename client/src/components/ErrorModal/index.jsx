import React from 'react';

import { Button, Modal, ModalBody, ModalFooter, ModalHeader } from 'reactstrap';

import { AdvancedModal } from '../';

export default function (props) {
  return (
    <AdvancedModal isOpen>
      {(modal) => (
        <Modal
          className="modal-dialog-centered modal-danger"
          contentClassName="bg-gradient-danger"
          isOpen={modal.isOpen}
          toggle={modal.close}
        >
          <ModalHeader
            close={
              <button
                aria-label="Close"
                className="btn-close btn-close-white"
                type="button"
                onClick={modal.close}
              />
            }
          />
          <ModalBody>
            <div className="py-3 text-center">
              <i className="fas fa-exclamation-triangle fa-4x" />
              <h4 className="heading mt-4">Error!</h4>
              {props.errors.map((error, key) => (
                <p key={key}>{error.message || error}</p>
              ))}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button className="text-white ms-auto" color="link" type="button" onClick={modal.close}>
              Close
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </AdvancedModal>
  );
}
