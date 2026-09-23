interface StartupModalProps {
  open: boolean;
  onClose: () => void;
}

export function StartupModal({ open, onClose }: StartupModalProps) {
  if (!open) return null;
  return (
        <div className="modal-overlay" onClick={onClose}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Power-on order</h2>
              <button
                className="modal-close"
                onClick={onClose}
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
            <p className="modal-lead">
              <strong>Power on BOTH the generator and the AIT (matching network) before connecting in
              this software</strong> — generator first, then the AIT. Turning the AIT on first, or
              after the generator is connected over USB, moves the tune and load caps and ruins the
              tune.
            </p>
            <ol className="modal-steps">
              <li>Load the part into the electrodes inside the chamber.</li>
              <li>Connect the VNA and assess the match (S11).</li>
              <li>Turn on the AIT; adjust tune / load to reach a match.</li>
              <li>Turn off the AIT; unplug the VNA.</li>
              <li>Plug the N-type cable into the RF generator.</li>
              <li>Confirm everything is in place and safe.</li>
              <li>
                <strong>Turn on the generator → wait for boot → turn on the AIT.</strong>
              </li>
              <li>
                <strong>Only then connect the generator here</strong> (Connect → Scan → Connect). If you
                ever need to power-cycle the AIT, disconnect here first.
              </li>
            </ol>
            <button className="btn accent full" onClick={onClose}>
              Got it
            </button>
          </div>
        </div>
  );
}
