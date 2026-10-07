/// Tracks the adapter-started continuation after `startedNewTurn`.
/// Thread status updates are ordered, but the previous turn's idle update
/// can still be buffered when the steering response arrives.
#[derive(Default)]
pub(crate) struct CodexSteeredTurn {
    last_active: Option<bool>,
    stage: Option<Stage>,
}

enum Stage {
    OldIdle,
    NewActive,
    NewIdle,
}

impl CodexSteeredTurn {
    pub(crate) fn start(&mut self) {
        self.stage = Some(if self.last_active == Some(false) {
            Stage::NewActive
        } else {
            Stage::OldIdle
        });
    }

    pub(crate) fn waiting(&self) -> bool {
        self.stage.is_some()
    }

    pub(crate) fn observe(&mut self, active: bool) -> bool {
        self.last_active = Some(active);
        match (&self.stage, active) {
            (Some(Stage::OldIdle), false) => self.stage = Some(Stage::NewActive),
            (Some(Stage::NewActive), true) => self.stage = Some(Stage::NewIdle),
            (Some(Stage::NewIdle), false) => {
                self.stage = None;
                return true;
            }
            _ => {}
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_for_the_new_turn_instead_of_the_buffered_old_idle() {
        let mut turn = CodexSteeredTurn::default();
        assert!(!turn.observe(true));
        turn.start();
        assert!(turn.waiting());
        assert!(!turn.observe(false));
        assert!(turn.waiting());
        assert!(!turn.observe(true));
        assert!(turn.observe(false));
        assert!(!turn.waiting());
        assert!(!turn.observe(false));
    }

    #[test]
    fn handles_an_old_idle_already_read_before_the_steering_reply() {
        let mut turn = CodexSteeredTurn::default();
        turn.observe(false);
        turn.start();
        assert!(!turn.observe(true));
        assert!(turn.observe(false));
    }

    #[test]
    fn ordinary_prompt_status_does_not_finish_a_steered_turn() {
        let mut turn = CodexSteeredTurn::default();
        assert!(!turn.observe(true));
        assert!(!turn.observe(false));
        assert!(!turn.waiting());
    }

    #[test]
    fn a_second_steer_can_start_another_continuation() {
        let mut turn = CodexSteeredTurn::default();
        turn.observe(false);
        turn.start();
        turn.observe(true);
        turn.observe(false);
        turn.start();
        assert!(turn.waiting());
        assert!(!turn.observe(true));
        assert!(turn.observe(false));
    }
}
